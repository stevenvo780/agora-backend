/**
 * POST /api/upload/signed-url
 * Genera un signed URL PUT para subida directa cliente → MinIO. El cliente luego
 * llama POST /api/upload/register para registrar el documento.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, sanitizeFileName } from '@/lib/storage-path';
import { calculateOwnedStorageUsageBytes } from '@/lib/storage-usage';
import { formatStorageSize, getStorageLimitMB } from '@/types/subscription';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { getActivePlanId } from '@/app/api/payments/helpers';
import { isNasConfigured, presignPut } from '@/lib/nas-storage';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) {
            return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
        }

        const body = await req.json();
        const {
            fileName,
            mimeType,
            workspaceId = PERSONAL_WORKSPACE_ID,
            folder = 'No estructurado'
        } = body as {
            fileName?: string;
            mimeType?: string;
            workspaceId?: string;
            folder?: string;
            fileSize?: number;
        };

        if (!fileName || !mimeType) {
            return NextResponse.json({ error: 'fileName and mimeType required' }, { status: 400 });
        }

        if (!isPersonalWorkspaceId(workspaceId)) {
            const member = await isWorkspaceMember(workspaceId, auth.uid);
            if (!member) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
        }

        const fileSize = typeof body.fileSize === 'number' ? body.fileSize : NaN;
        if (!Number.isFinite(fileSize) || fileSize <= 0) {
            return NextResponse.json({ error: 'fileSize must be a positive number' }, { status: 400 });
        }

        const planId = await getActivePlanId(auth.uid);
        const limitMB = getStorageLimitMB(planId);
        const limitBytes = limitMB * 1024 * 1024;
        const totalBytes = await calculateOwnedStorageUsageBytes(auth.uid);

        if (totalBytes + fileSize > limitBytes) {
            const usedMB = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
            return NextResponse.json({
                error: `Límite de almacenamiento alcanzado. Usas ${formatStorageSize(usedMB)} de ${formatStorageSize(limitMB)}. Mejora tu plan para subir más archivos.`,
                code: 'STORAGE_LIMIT_EXCEEDED',
                usedMB,
                limitMB
            }, { status: 413 });
        }

        const safeName = sanitizeFileName(fileName);
        const normalizedFolder = normalizeFolderPath(folder);
        const storagePath = buildStoragePath({
            workspaceId,
            ownerId: auth.uid,
            folder: normalizedFolder,
            fileName: safeName
        });

        const signedUrl = await presignPut(storagePath, 15 * 60, mimeType);

        return NextResponse.json({
            signedUrl,
            storagePath,
            storageBackend: 'minio',
            fileName: safeName,
            originalName: fileName,
            mimeType,
            workspaceId,
            folder: normalizedFolder,
            ownerId: auth.uid
        });
    } catch (error: unknown) {
        console.error('Signed URL Error:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
