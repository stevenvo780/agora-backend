import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { invalidateStorageUsageCache } from '@/lib/storage-usage';
import { isNasConfigured, completeMultipartUpload, headObjectSize, presignGet, abortMultipartUpload } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';
import { invalidateAgoraWorkspaceContext } from '@/lib/agora-ai/context';

export const runtime = 'nodejs';

interface CompletePart {
    partNumber: number;
    etag: string;
}

interface CompleteBody {
    uploadId: string;
    storagePath: string;
    parts: CompletePart[];
    fileName: string;
    originalName: string;
    mimeType: string;
    workspaceId: string;
    folder: string;
}

const parseBody = (raw: unknown): { ok: true; value: CompleteBody } | { ok: false; error: string } => {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body must be an object' };
    const r = raw as Record<string, unknown>;
    const uploadId = typeof r['uploadId'] === 'string' ? r['uploadId'].trim() : '';
    const storagePath = typeof r['storagePath'] === 'string' ? r['storagePath'].trim() : '';
    const fileName = typeof r['fileName'] === 'string' ? r['fileName'].trim() : '';
    const originalName = typeof r['originalName'] === 'string' ? r['originalName'] : fileName;
    const mimeType = typeof r['mimeType'] === 'string' && r['mimeType'].trim()
        ? r['mimeType'].trim()
        : 'application/octet-stream';
    const workspaceId = typeof r['workspaceId'] === 'string' && r['workspaceId'].trim()
        ? r['workspaceId'].trim()
        : PERSONAL_WORKSPACE_ID;
    const folder = typeof r['folder'] === 'string' ? r['folder'] : '';
    const rawParts = r['parts'];
    if (!uploadId) return { ok: false, error: 'uploadId ausente' };
    if (!storagePath) return { ok: false, error: 'storagePath ausente' };
    if (!fileName) return { ok: false, error: 'fileName ausente' };
    if (!Array.isArray(rawParts) || rawParts.length === 0) {
        return { ok: false, error: 'parts must be a non-empty array' };
    }
    const parts: CompletePart[] = [];
    for (const p of rawParts) {
        if (typeof p !== 'object' || p === null) {
            return { ok: false, error: 'parts contains invalid entry' };
        }
        const pr = p as Record<string, unknown>;
        const partNumber = typeof pr['partNumber'] === 'number' ? pr['partNumber'] : Number.NaN;
        const etag = typeof pr['etag'] === 'string' ? pr['etag'].trim() : '';
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
            return { ok: false, error: 'parts[].partNumber must be integer in [1, 10000]' };
        }
        if (!etag) return { ok: false, error: 'parts[].etag ausente' };
        parts.push({ partNumber, etag });
    }
    return {
        ok: true,
        value: { uploadId, storagePath, parts, fileName, originalName, mimeType, workspaceId, folder }
    };
};

const validatePathOwnership = async (
    storagePath: string,
    workspaceId: string,
    uid: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
    if (isPersonalWorkspaceId(workspaceId)) {
        if (!storagePath.startsWith(`users/${uid}/`)) {
            return { ok: false, status: 403, error: 'Access denied: Invalid storage path' };
        }
        return { ok: true };
    }
    const member = await isWorkspaceMember(workspaceId, uid);
    if (!member) return { ok: false, status: 403, error: 'Forbidden' };
    if (!storagePath.startsWith(`workspaces/${workspaceId}/`)) {
        return { ok: false, status: 403, error: 'Access denied: Invalid storage path' };
    }
    return { ok: true };
};

const isMarkdownLike = (mimeType: string, name: string): boolean => {
    const lowerMime = mimeType.toLowerCase();
    const lowerName = name.toLowerCase();
    return lowerMime === 'text/markdown'
        || lowerMime === 'text/x-markdown'
        || lowerName.endsWith('.md')
        || lowerName.endsWith('.markdown');
};

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const rawBody = await req.json().catch(() => null);
        const parsed = parseBody(rawBody);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

        const { uploadId, storagePath, parts, fileName, originalName, mimeType, workspaceId, folder } = parsed.value;

        const ownership = await validatePathOwnership(storagePath, workspaceId, auth.uid);
        if (!ownership.ok) {
            return NextResponse.json({ error: ownership.error }, { status: ownership.status });
        }

        try {
            await completeMultipartUpload(storagePath, uploadId, parts);
        } catch (err) {
            await abortMultipartUpload(storagePath, uploadId).catch(() => undefined);
            throw err;
        }

        const size = await headObjectSize(storagePath) ?? 0;
        const url = await presignGet(storagePath, 60 * 60);
        const docType = isMarkdownLike(mimeType, originalName || fileName) ? DocumentType.Text : DocumentType.File;

        const docData: Record<string, unknown> = {
            name: originalName || fileName,
            type: docType,
            url,
            mimeType,
            storagePath,
            storageBackend: 'minio',
            contentHash: null,
            size,
            version: 1,
            baseVersion: 0,
            syncState: 'synced',
            lastWriter: auth.uid,
            ownerId: auth.uid,
            workspaceId,
            folder,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        };

        const docRef = await adminDb.collection('documents').add(docData);

        invalidateAgoraWorkspaceContext(workspaceId);
        invalidateStorageUsageCache(auth.uid);

        await emitPing({
            scope: 'document',
            workspaceId,
            userId: auth.uid,
            docId: docRef.id,
            path: storagePath,
            version: 1,
            contentHash: null,
            sender: auth.uid
        }).catch((err) => {
            console.warn('[multipart/complete] emitPing failed:', getErrorMessage(err));
        });

        return NextResponse.json({
            id: docRef.id,
            docId: docRef.id,
            url,
            name: originalName || fileName,
            type: docType,
            path: storagePath,
            storagePath,
            storageBackend: 'minio',
            mimeType,
            fileName,
            originalName: originalName || fileName,
            ownerId: auth.uid,
            workspaceId,
            folder,
            size
        });
    } catch (error: unknown) {
        console.error('[multipart/complete]', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
