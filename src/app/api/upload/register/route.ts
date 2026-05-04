/**
 * POST /api/upload/register — el cliente subió un archivo directo a MinIO usando
 * un signed URL. Aquí lo registramos como documento Firestore.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { calculateOwnedStorageUsageBytes, invalidateStorageUsageCache } from '@/lib/storage-usage';
import { formatStorageSize, getStorageLimitMB } from '@/types/subscription';
import { getActivePlanId } from '@/app/api/payments/helpers';
import { isNasConfigured, objectExists, getObjectBuffer, deleteObject, presignGet } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';
import crypto from 'node:crypto';
import { parseRegisterUploadRequestPayload } from '@agora/contracts';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const rawBody = await req.json().catch(() => null);
        const parsed = parseRegisterUploadRequestPayload(rawBody);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

        const {
            storagePath,
            fileName,
            originalName,
            mimeType,
            workspaceId = PERSONAL_WORKSPACE_ID,
            folder = '',
            size: declaredSize
        } = parsed.value;

        if (isPersonalWorkspaceId(workspaceId)) {
            if (!storagePath.startsWith(`users/${auth.uid}/`)) {
                return NextResponse.json({ error: 'Access denied: Invalid storage path' }, { status: 403 });
            }
        } else {
            const member = await isWorkspaceMember(workspaceId, auth.uid);
            if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            if (!storagePath.startsWith(`workspaces/${workspaceId}/`)) {
                return NextResponse.json({ error: 'Access denied: Invalid storage path' }, { status: 403 });
            }
        }

        if (!(await objectExists(storagePath))) {
            return NextResponse.json({ error: 'File not found in NAS' }, { status: 404 });
        }

        // Calcular hash + tamaño real bajándolo (necesario para version+contentHash).
        // Nota: para archivos muy grandes se puede saltar y confiar en `declaredSize`,
        // pero la verificación es fuerte y barata para <50MB.
        let size = typeof declaredSize === 'number' ? declaredSize : 0;
        let contentHash: string | null = null;
        try {
            const buf = await getObjectBuffer(storagePath);
            if (buf) {
                size = buf.length;
                contentHash = crypto.createHash('sha256').update(buf).digest('hex');
            }
        } catch (err) {
            console.warn('register: failed to compute hash', getErrorMessage(err));
        }

        const planId = await getActivePlanId(auth.uid);
        const limitMB = getStorageLimitMB(planId);
        const limitBytes = limitMB * 1024 * 1024;
        const currentUsageBytes = await calculateOwnedStorageUsageBytes(auth.uid);

        if (currentUsageBytes + size > limitBytes) {
            await deleteObject(storagePath).catch(() => undefined);
            const usedMB = Math.round((currentUsageBytes / (1024 * 1024)) * 100) / 100;
            return NextResponse.json({
                error: `Límite de almacenamiento alcanzado. Usas ${formatStorageSize(usedMB)} de ${formatStorageSize(limitMB)}. Mejora tu plan para subir más archivos.`,
                code: 'STORAGE_LIMIT_EXCEEDED',
                usedMB,
                limitMB
            }, { status: 413 });
        }

        const url = await presignGet(storagePath, 60 * 60);

        const docRef = await adminDb.collection('documents').add({
            name: originalName || fileName,
            type: DocumentType.File,
            url,
            mimeType: mimeType || 'application/octet-stream',
            storagePath,
            storageBackend: 'minio',
            contentHash,
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
        });

        invalidateStorageUsageCache(auth.uid);

        await emitPing({
            scope: 'document',
            workspaceId,
            userId: auth.uid,
            docId: docRef.id,
            path: storagePath,
            version: 1,
            contentHash,
            sender: auth.uid
        }).catch(() => undefined);

        return NextResponse.json({
            id: docRef.id,
            url,
            name: originalName || fileName,
            type: DocumentType.File,
            path: storagePath,
            storagePath,
            storageBackend: 'minio',
            contentHash,
            mimeType: mimeType || 'application/octet-stream',
            ownerId: auth.uid,
            folder,
            workspaceId,
            size,
            updatedAt: { seconds: Date.now() / 1000 }
        });
    } catch (error: unknown) {
        console.error('Register Upload Error:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
