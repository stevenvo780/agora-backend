import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, sanitizeFileName } from '@/lib/storage-path';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { enforceStorageQuota } from '@/lib/plan-guard';
import { isNasConfigured, createMultipartUpload } from '@/lib/nas-storage';

export const runtime = 'nodejs';

const PART_SIZE_BYTES = 8 * 1024 * 1024;

interface InitiateBody {
    fileName: string;
    mimeType: string;
    workspaceId: string;
    folder: string;
    fileSize: number;
}

const parseBody = (raw: unknown): { ok: true; value: InitiateBody } | { ok: false; error: string } => {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body must be an object' };
    const r = raw as Record<string, unknown>;
    const fileName = typeof r['fileName'] === 'string' ? r['fileName'].trim() : '';
    const mimeType = typeof r['mimeType'] === 'string' ? r['mimeType'].trim() : '';
    const workspaceId = typeof r['workspaceId'] === 'string' && r['workspaceId'].trim()
        ? r['workspaceId'].trim()
        : PERSONAL_WORKSPACE_ID;
    const folder = typeof r['folder'] === 'string' ? r['folder'] : '';
    const fileSize = typeof r['fileSize'] === 'number' ? r['fileSize'] : Number.NaN;
    if (!fileName) return { ok: false, error: 'fileName ausente' };
    if (!mimeType) return { ok: false, error: 'mimeType ausente' };
    if (!Number.isFinite(fileSize) || fileSize <= 0) return { ok: false, error: 'fileSize must be a positive number' };
    return { ok: true, value: { fileName, mimeType, workspaceId, folder, fileSize } };
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

        const { fileName, mimeType, workspaceId, folder, fileSize } = parsed.value;

        if (!isPersonalWorkspaceId(workspaceId)) {
            const member = await isWorkspaceMember(workspaceId, auth.uid);
            if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const quotaResp = await enforceStorageQuota(auth.uid, fileSize);
        if (quotaResp) return quotaResp;

        const safeName = sanitizeFileName(fileName);
        const normalizedFolder = normalizeFolderPath(folder);
        const storagePath = buildStoragePath({
            workspaceId,
            ownerId: auth.uid,
            folder: normalizedFolder,
            fileName: safeName
        });

        const uploadId = await createMultipartUpload(storagePath, mimeType);

        return NextResponse.json({
            uploadId,
            storagePath,
            fileName: safeName,
            originalName: fileName,
            mimeType,
            workspaceId,
            folder: normalizedFolder,
            partSize: PART_SIZE_BYTES
        });
    } catch (error: unknown) {
        console.error('[multipart/initiate]', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
