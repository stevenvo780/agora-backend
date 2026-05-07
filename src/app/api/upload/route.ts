/**
 * POST /api/upload — subida directa multipart al hub.
 * Sube el blob a MinIO (NAS) y registra metadata en Firestore.
 * Firebase Storage ya no se usa para escrituras nuevas.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, sanitizeFileName } from '@/lib/storage-path';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { putObject, presignGet, isNasConfigured, deleteObject } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';
import { computeSearchableContent } from '@/lib/search/searchable-content';
import { invalidateAgoraWorkspaceContext } from '@/lib/agora-ai/context';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) {
            return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
        }

        const formData = await req.formData();
        const fileEntry = formData.get('file');
        const ownerId = auth.uid;
        const workspaceIdEntry = formData.get('workspaceId');
        const workspaceId = typeof workspaceIdEntry === 'string' && workspaceIdEntry.trim()
            ? workspaceIdEntry
            : PERSONAL_WORKSPACE_ID;
        const folderField = formData.get('folder');
        const folder = normalizeFolderPath(typeof folderField === 'string' ? folderField : undefined);

        if (!(fileEntry instanceof File)) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }
        const file = fileEntry;

        if (file.size > MAX_FILE_SIZE) {
            return NextResponse.json({ error: 'El archivo supera el límite de 50MB' }, { status: 413 });
        }

        if (!isPersonalWorkspaceId(workspaceId)) {
            const member = await isWorkspaceMember(workspaceId, auth.uid);
            if (!member) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
        }

        const safeName = sanitizeFileName(file.name);
        const storagePath = buildStoragePath({
            workspaceId,
            ownerId,
            folder,
            fileName: safeName
        });

        const buf = Buffer.from(await file.arrayBuffer());
        const { contentHash, size } = await putObject(storagePath, buf, {
            contentType: file.type,
            metadata: { 'agora-original-name': file.name, 'agora-owner': ownerId }
        });
        const url = await presignGet(storagePath, 60 * 60);

        const lowerMime = (file.type || '').toLowerCase();
        const lowerName = file.name.toLowerCase();
        const isMarkdownUpload = lowerMime === 'text/markdown'
            || lowerMime === 'text/x-markdown'
            || lowerName.endsWith('.md')
            || lowerName.endsWith('.markdown');

        const docData: Record<string, unknown> = {
            name: file.name,
            type: isMarkdownUpload ? DocumentType.Text : DocumentType.File,
            url,
            mimeType: file.type,
            storagePath,
            storageBackend: 'minio',
            contentHash,
            size,
            version: 1,
            baseVersion: 0,
            syncState: 'synced',
            lastWriter: ownerId,
            ownerId,
            workspaceId,
            folder,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        };

        if (isMarkdownUpload) {
            try {
                const text = buf.toString('utf8');
                const searchable = computeSearchableContent(text);
                if (searchable.length > 0) docData.searchableContent = searchable;
            } catch (err) {
                console.warn('[upload] computeSearchableContent failed:', getErrorMessage(err));
            }
        }

        let docRef: FirebaseFirestore.DocumentReference;
        try {
            docRef = await adminDb.collection('documents').add(docData);
        } catch (err) {
            await deleteObject(storagePath).catch(() => undefined);
            throw err;
        }

        invalidateAgoraWorkspaceContext(workspaceId);

        await emitPing({
            scope: 'document',
            workspaceId,
            userId: ownerId,
            docId: docRef.id,
            path: storagePath,
            version: 1,
            contentHash,
            sender: ownerId
        }).catch(() => undefined);

        return NextResponse.json({
            id: docRef.id,
            url,
            name: file.name,
            type: isMarkdownUpload ? DocumentType.Text : DocumentType.File,
            path: storagePath,
            storagePath,
            storageBackend: 'minio',
            contentHash,
            mimeType: file.type,
            ownerId,
            folder,
            size,
            updatedAt: { seconds: Date.now() / 1000 }
        });
    } catch (error: unknown) {
        console.error('Upload Error:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
