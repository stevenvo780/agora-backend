/**
 * /api/documents/[id]
 * GET / PUT / DELETE — usa Firestore (metadata) + MinIO (blobs).
 * El campo `content` ya NO se persiste; la verdad vive en MinIO bajo `storagePath`.
 */
import { env } from '@/lib/env';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, buildStoragePrefix, ensureTextFileName, sanitizeFileName, getStorageBaseName } from '@/lib/storage-path';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { mockGetDoc, mockUpdateDoc, mockDeleteDoc } from '@/lib/insecure-mock-store';
import { invalidateStorageUsageCache } from '@/lib/storage-usage';
import { isNasConfigured, putObject, moveObject, deleteObject, presignGet, getObjectBuffer } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';
import { parseDocumentUpdatePayload } from '@agora/contracts';
import { isDotfileName } from '@agora/contracts';
import { computeSearchableContent } from '@/lib/search/searchable-content';

const isInsecure = env.ALLOW_INSECURE_AUTH();

type StoredDocumentRecord = Record<string, unknown>;
type RouteContext = { params: Promise<{ id: string }> };

const canAccessDoc = async (data: Record<string, unknown> | undefined, uid: string) => {
    const workspaceId = typeof data?.workspaceId === 'string' ? data.workspaceId : null;
    if (isPersonalWorkspaceId(workspaceId)) {
        return data?.ownerId === uid;
    }
    if (!workspaceId) return false;
    return isWorkspaceMember(workspaceId, uid);
};

export async function PUT(req: NextRequest, context: RouteContext) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id } = await context.params;

        if (isInsecure) {
            const body = await req.json();
            const ok = mockUpdateDoc(id, body as Record<string, unknown>);
            if (!ok) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
            return NextResponse.json({ status: 'success' });
        }

        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }

        const rawBody = await req.json().catch(() => null);
        const parsed = parseDocumentUpdatePayload(rawBody);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        const body = parsed.value;

        const docRef = adminDb.collection('documents').doc(id);
        const snap = await docRef.get();
        if (!snap.exists) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

        const existingData = snap.data() as StoredDocumentRecord | undefined;
        if (!(await canAccessDoc(existingData, auth.uid))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const existingWorkspaceId = typeof existingData?.workspaceId === 'string' ? existingData.workspaceId : PERSONAL_WORKSPACE_ID;
        const existingOwnerId = typeof existingData?.ownerId === 'string' ? existingData.ownerId : auth.uid;
        const existingFolder = typeof existingData?.folder === 'string' ? existingData.folder : undefined;
        const existingStoragePath = typeof existingData?.storagePath === 'string' ? existingData.storagePath : undefined;
        const isFileDoc = existingData?.type === DocumentType.File;

        const normalizedFolder = typeof body.folder === 'string'
            ? normalizeFolderPath(body.folder)
            : normalizeFolderPath(existingFolder);
        const existingName = typeof existingData?.name === 'string' ? existingData.name : undefined;
        const nextName = typeof body.name === 'string' ? body.name : existingName;
        const nextFileName = isFileDoc
            ? sanitizeFileName(nextName || 'archivo')
            : ensureTextFileName(nextName || 'Sin titulo');

        let storagePath = existingStoragePath;
        let targetStoragePath = storagePath;
        if (storagePath) {
            const baseName = typeof body.name === 'string' ? nextFileName : getStorageBaseName(storagePath);
            const prefix = buildStoragePrefix(existingWorkspaceId, existingOwnerId);
            targetStoragePath = `${prefix}/${normalizedFolder}/${baseName}`;
        } else if (body.content !== undefined && !isFileDoc) {
            targetStoragePath = buildStoragePath({
                workspaceId: existingWorkspaceId,
                ownerId: existingOwnerId,
                folder: normalizedFolder,
                fileName: nextFileName
            });
        }

        if (storagePath && targetStoragePath && storagePath !== targetStoragePath) {
            try {
                await moveObject(storagePath, targetStoragePath);
                storagePath = targetStoragePath;
            } catch (err) {
                console.warn('NAS moveObject failed:', getErrorMessage(err));
            }
        } else if (!storagePath && targetStoragePath) {
            storagePath = targetStoragePath;
        }

        let contentHash: string | null = null;
        let size: number | null = null;
        if (body.content !== undefined && !isFileDoc && storagePath) {
            // SALVAGUARDA: nunca sobrescribir un blob no-vacío con contenido vacío
            // a menos que el cliente lo pida explícitamente (allowEmptyOverwrite=true)
            // Y sea el owner del documento. Esto previene perder docs por bug del
            // editor o request maliciosa de un colaborador.
            const newContent: string = body.content ?? '';
            const allowEmpty = body.allowEmptyOverwrite === true && existingOwnerId === auth.uid;
            if (newContent.length === 0 && !allowEmpty) {
                const existingSize = typeof existingData?.size === 'number' ? existingData.size : 0;
                if (existingSize > 0) {
                    return NextResponse.json({
                        error: 'refused-empty-overwrite',
                        message: 'Se rechazó guardar contenido vacío sobre un documento que tenía contenido. Usa allowEmptyOverwrite:true para forzar.',
                        existingSize
                    }, { status: 409 });
                }
            }
            const ext = (storagePath.match(/\.[^./]+$/)?.[0] ?? '').toLowerCase();
            const isMd = ext === '.md' || ext === '.markdown';
            const ct = isMd ? 'text/markdown'
                : (typeof existingData?.mimeType === 'string' ? existingData.mimeType : 'text/plain');
            const out = await putObject(storagePath, newContent, {
                contentType: ct,
                metadata: { 'agora-source': 'api-update', 'agora-writer': auth.uid }
            });
            contentHash = out.contentHash;
            size = out.size;
        }

        const updateData: Record<string, unknown> = {
            updatedAt: FieldValue.serverTimestamp()
        };

        if (body.content !== undefined && !isFileDoc) {
            updateData.content = FieldValue.delete();
            updateData.storageBackend = 'minio';
            if (contentHash) updateData.contentHash = contentHash;
            if (size !== null) updateData.size = size;
            const baseVersion = typeof existingData?.version === 'number' ? existingData.version : 0;
            updateData.baseVersion = baseVersion;
            updateData.version = baseVersion + 1;
            updateData.syncState = 'synced';
            updateData.lastWriter = auth.uid;

            // searchableContent denormalizado: re-compute en cada autosave.
            // Si el content viene vacío, borrar el campo para no dejar stale.
            const newContent = body.content ?? '';
            const searchable = computeSearchableContent(newContent);
            updateData.searchableContent = searchable.length > 0 ? searchable : FieldValue.delete();
        }
        if (typeof body.name === 'string') updateData.name = body.name;
        if (typeof body.type === 'string') updateData.type = body.type;
        if (typeof body.mimeType === 'string' || body.mimeType === null) updateData.mimeType = body.mimeType ?? null;
        if (typeof body.folder === 'string') updateData.folder = normalizeFolderPath(body.folder);
        if (typeof body.size === 'number' && size === null) updateData.size = body.size;
        if (typeof body.order === 'number') updateData.order = body.order;
        if (storagePath && storagePath !== existingStoragePath) {
            updateData.storagePath = storagePath;
        }

        const shouldRefreshFileUrl = Boolean(
            storagePath
            && isFileDoc
            && (
                storagePath !== existingStoragePath
                || body.refreshUrl === true
                || typeof body.mimeType === 'string'
                || typeof body.size === 'number'
            )
        );

        if (storagePath && shouldRefreshFileUrl) {
            try {
                updateData.url = await presignGet(storagePath, 60 * 60);
            } catch (error) {
                console.warn('Failed to refresh file URL:', getErrorMessage(error));
            }
        }

        await docRef.update(updateData);

        await emitPing({
            scope: 'document',
            workspaceId: existingWorkspaceId,
            userId: existingOwnerId,
            docId: id,
            path: storagePath ?? null,
            version: typeof updateData.version === 'number' ? updateData.version : null,
            contentHash,
            sender: auth.uid
        }).catch(() => undefined);

        return NextResponse.json({
            status: 'success',
            ...(typeof updateData.version === 'number' ? { version: updateData.version } : {}),
            ...(contentHash ? { contentHash } : {})
        });
    } catch (error: unknown) {
        console.error('[documents/[id] PUT] error', error);
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function GET(req: NextRequest, context: RouteContext) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id } = await context.params;

        if (isInsecure) {
            const doc = mockGetDoc(id);
            if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
            return NextResponse.json(doc);
        }

        const docSnap = await adminDb.collection('documents').doc(id).get();
        if (!docSnap.exists) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

        const data = (docSnap.data() ?? {}) as StoredDocumentRecord;
        if (!(await canAccessDoc(data, auth.uid))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const storagePath = typeof data.storagePath === 'string' ? data.storagePath : undefined;
        const docName = typeof data.name === 'string' ? data.name : '';
        // Normaliza dotfiles legacy con type='file' — el editor los abre como
        // texto y el signed URL caduca antes de ser usado.
        if (isDotfileName(docName) && data.type === DocumentType.File) {
            data.type = DocumentType.Text;
            data.mimeType = 'text/plain';
        }
        if (data.type === DocumentType.File && storagePath && isNasConfigured()) {
            try {
                const safeName = (typeof data.name === 'string' ? data.name : '')
                    .replace(/[\r\n"\\]/g, '_')
                    .slice(0, 200) || 'archivo';
                const mime = typeof data.mimeType === 'string' && data.mimeType.trim()
                    ? data.mimeType.trim()
                    : undefined;
                // Office Online y Google Docs Viewer detectan el tipo de archivo
                // a partir de Content-Disposition/Content-Type, no del path.
                // Sin esto, una URL firmada con query string termina en
                // "filenotfound.htm" en officeapps.live.com.
                data.url = await presignGet(storagePath, 60 * 60, {
                    responseContentDisposition: `inline; filename="${safeName}"`,
                    responseContentType: mime
                });
            } catch (error) {
                console.warn('Failed to refresh signed URL on GET:', getErrorMessage(error));
            }
        }

        // Para docs de texto, inyectar `content` desde MinIO si el cliente lo pide.
        // Esto evita que el editor cargue con state.content="" y luego machaque MinIO con vacío.
        const isTextDoc = data.type === DocumentType.Text || data.type === 'markdown' || (!data.type && storagePath);
        const url = new URL(req.url);
        const includeContent = url.searchParams.get('includeContent') !== 'false';
        if (isTextDoc && storagePath && includeContent && isNasConfigured()) {
            try {
                const buf = await getObjectBuffer(storagePath);
                if (buf) data.content = buf.toString('utf8');
            } catch (error) {
                console.warn('Failed to inline content from NAS:', getErrorMessage(error));
            }
        }

        return NextResponse.json({ id: docSnap.id, ...data });
    } catch (error: unknown) {
        console.error('Error fetching document:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id } = await context.params;

        if (isInsecure) {
            mockDeleteDoc(id);
            return NextResponse.json({ status: 'deleted' });
        }

        const docRef = adminDb.collection('documents').doc(id);
        const snap = await docRef.get();
        if (!snap.exists) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

        const data = snap.data() as StoredDocumentRecord | undefined;
        if (!(await canAccessDoc(data, auth.uid))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const storagePath = typeof data?.storagePath === 'string' ? data.storagePath : undefined;

        if (storagePath) {
            const countSnap = await adminDb.collection('documents')
                .where('storagePath', '==', storagePath)
                .where(FieldPath.documentId(), '!=', id)
                .count()
                .get();
            const hasOtherReferences = countSnap.data().count > 0;
            if (!hasOtherReferences && isNasConfigured()) {
                await deleteObject(storagePath).catch((err) => console.warn('NAS delete failed', getErrorMessage(err)));
            }
        }

        await docRef.delete();
        invalidateStorageUsageCache(auth.uid);

        await emitPing({
            scope: 'document',
            workspaceId: typeof data?.workspaceId === 'string' ? data.workspaceId : null,
            userId: typeof data?.ownerId === 'string' ? data.ownerId : null,
            docId: id,
            path: storagePath ?? null,
            version: null,
            contentHash: null,
            sender: auth.uid
        }).catch(() => undefined);

        return NextResponse.json({ status: 'deleted' });
    } catch (error: unknown) {
        console.error('Error deleting document:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
