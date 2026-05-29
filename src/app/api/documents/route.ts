/**
 * /api/documents
 * GET (list) / POST (create) — Firestore metadata + MinIO blobs.
 * `documents.content` ya no se persiste.
 */
import { env } from '@/lib/env';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, canWriteWorkspace, requireAuth } from '@/lib/server-auth';
import { enforceStorageQuota } from '@/lib/plan-guard';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, ensureTextFileName } from '@/lib/storage-path';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { mockCreateDoc, mockListDocs } from '@/lib/insecure-mock-store';
import { isNasConfigured, isStaleBlobUrl } from '@/lib/nas-storage';
import { normalizeDotfileLegacy, parseDocumentCreatePayload } from '@agora/contracts';
import { createDocumentBlob } from '@/lib/documents/writeDocumentBlob';
import { decodeDocumentsCursor, encodeDocumentsCursor } from '@/lib/documents/cursor';
import { resolveDocumentMimeType, deriveDocumentName } from '@/lib/documents/metadata-defaults';

const isInsecure = env.ALLOW_INSECURE_AUTH();

export async function POST(req: NextRequest) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        if (isInsecure) {
            const body = (await req.json()) as Record<string, unknown>;
            const folder = normalizeFolderPath(typeof body.folder === 'string' ? body.folder : undefined);
            const rawType = typeof body.type === 'string' ? body.type : DocumentType.Text;
            const rawContent = typeof body.content === 'string' ? body.content : '';
            const rawName = typeof body.name === 'string' && body.name.trim() ? body.name : 'Sin titulo';
            const derivedName = rawType === DocumentType.Text
                ? deriveDocumentName(rawName, rawContent)
                : rawName;
            const rawMime = typeof body.mimeType === 'string' ? body.mimeType : null;
            const doc = mockCreateDoc({
                name: derivedName,
                content: rawContent,
                type: rawType,
                workspaceId: typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : PERSONAL_WORKSPACE_ID,
                folder,
                ownerId: auth.uid,
                mimeType: resolveDocumentMimeType(rawMime, rawType, derivedName),
                order: typeof body.order === 'number' ? body.order : undefined
            });
            return NextResponse.json({ id: doc.id, status: 'success' });
        }

        if (!isNasConfigured()) {
            return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        }

        const rawBody = await req.json().catch(() => null);
        const parsed = parseDocumentCreatePayload(rawBody);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        const { name, content, type, workspaceId, folder, mimeType, url, storagePath, order } = parsed.value;
        const normalizedFolder = normalizeFolderPath(folder ?? undefined);
        const resolvedWorkspaceId = workspaceId ?? PERSONAL_WORKSPACE_ID;
        const ownerId = auth.uid;
        const docType = type;
        // BUG B4: si el body trae name="Sin titulo" (default Zod) o vacío y el
        // contenido arranca con `# Heading`, usar ese H1 como nombre del doc.
        const docName = docType === DocumentType.Text
            ? deriveDocumentName(name, content)
            : name;
        // BUG B1: el schema del front (resolvedDocumentMetaSchema) exige
        // `mimeType: string` — escribir null hace que 1493 docs no abran.
        // Inferimos siempre un mime válido a partir de type/nombre.
        const resolvedMimeType = resolveDocumentMimeType(mimeType, docType, docName);

        if (!isPersonalWorkspaceId(resolvedWorkspaceId)) {
            const member = await isWorkspaceMember(resolvedWorkspaceId, auth.uid);
            if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            if (!(await canWriteWorkspace(resolvedWorkspaceId, auth.uid))) {
                return NextResponse.json(
                    { error: 'Insufficient permissions: viewer role is read-only', code: 'VIEWER_READONLY' },
                    { status: 403 }
                );
            }
        }

        const allowedPrefix = isPersonalWorkspaceId(resolvedWorkspaceId)
            ? `users/${ownerId}/`
            : `workspaces/${resolvedWorkspaceId}/`;
        if (storagePath && !storagePath.startsWith(allowedPrefix)) {
            return NextResponse.json({ error: 'Invalid storagePath' }, { status: 403 });
        }

        // Bug QA-W2: subir un .txt creaba 2 docs — el .txt original (type=file via
        // /api/upload) y un .md autogenerado por la conversión client-side. Si
        // detectamos que estamos por crear el .md derivativo (mismo stem, mismo
        // owner/workspace/folder, sibling .txt creado en los últimos 5 minutos),
        // devolvemos el .txt existente sin crear el duplicado.
        if (docType === DocumentType.Text && /\.md$/i.test(docName)) {
            const stem = docName.replace(/\.md$/i, '');
            if (stem.length > 0) {
                try {
                    const recentMs = Date.now() - 5 * 60 * 1000;
                    const dupQuery: FirebaseFirestore.Query = adminDb
                        .collection('documents')
                        .where('ownerId', '==', ownerId)
                        .where('workspaceId', '==', resolvedWorkspaceId)
                        .where('folder', '==', normalizedFolder)
                        .where('name', '==', `${stem}.txt`)
                        .where('type', '==', DocumentType.File)
                        .limit(1);
                    const dupSnap = await dupQuery.get();
                    if (!dupSnap.empty) {
                        const sibling = dupSnap.docs[0];
                        if (sibling) {
                            const data = sibling.data() as Record<string, unknown>;
                            const createdAt = data.createdAt as { toMillis?: () => number } | undefined;
                            const createdMs = createdAt && typeof createdAt.toMillis === 'function'
                                ? createdAt.toMillis()
                                : 0;
                            if (createdMs >= recentMs) {
                                return NextResponse.json({
                                    id: sibling.id,
                                    status: 'dedup',
                                    dedup: 'sibling-txt-exists',
                                    note: `Sibling .txt creado en los últimos 5min; se omite duplicado .md.`,
                                    storagePath: typeof data.storagePath === 'string' ? data.storagePath : null,
                                    storageBackend: typeof data.storageBackend === 'string' ? data.storageBackend : 'minio'
                                });
                            }
                        }
                    }
                } catch (err) {
                    // Si la query falla (e.g. índice faltante), seguimos con el flujo normal
                    // — preferimos crear el duplicado a romper el upload.
                    console.warn('[documents POST] dedup check fallo:', getErrorMessage(err));
                }
            }
        }

        let finalStoragePath = storagePath ?? undefined;
        if (docType !== DocumentType.File) {
            const fname = ensureTextFileName(docName);
            if (!finalStoragePath) {
                finalStoragePath = buildStoragePath({
                    workspaceId: resolvedWorkspaceId,
                    ownerId,
                    folder: normalizedFolder,
                    fileName: fname
                });
            }
        }

        const baseDocData: Record<string, unknown> = {
            name: docName,
            type: docType,
            mimeType: resolvedMimeType,
            ownerId,
            workspaceId: resolvedWorkspaceId,
            folder: normalizedFolder,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        };
        if (order !== null) baseDocData.order = order;
        if (url && finalStoragePath) baseDocData.url = url;

        const docRef = adminDb.collection('documents').doc();

        if (docType !== DocumentType.File && finalStoragePath && content !== null) {
            const incomingBytes = Buffer.byteLength(content, 'utf8');
            const quotaResp = await enforceStorageQuota(ownerId, incomingBytes);
            if (quotaResp) return quotaResp;
            const ext = (finalStoragePath.match(/\.[^./]+$/)?.[0] ?? '').toLowerCase();
            const contentType = ext === '.md' || ext === '.markdown'
                ? 'text/markdown'
                : resolvedMimeType;

            const result = await createDocumentBlob({
                docRef,
                content,
                workspaceId: resolvedWorkspaceId,
                ownerId,
                storagePath: finalStoragePath,
                contentType,
                source: 'api-create',
                writerId: ownerId,
                initialDocData: baseDocData,
                emitPingPayload: { userId: ownerId }
            });

            return NextResponse.json({
                id: docRef.id,
                status: 'success',
                storagePath: finalStoragePath,
                storageBackend: 'minio',
                version: result.version,
                contentHash: result.contentHash
            });
        }

        const fallbackData: Record<string, unknown> = {
            ...baseDocData,
            storageBackend: 'minio',
            version: 1,
            baseVersion: 0,
            syncState: 'synced',
            lastWriter: ownerId
        };
        if (finalStoragePath) fallbackData.storagePath = finalStoragePath;
        await docRef.set(fallbackData);

        return NextResponse.json({
            id: docRef.id,
            status: 'success',
            storagePath: finalStoragePath,
            storageBackend: 'minio',
            version: 1,
            contentHash: null
        });
    } catch (error: unknown) {
        console.error('Error creating document:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function GET(req: NextRequest) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        if (isInsecure) {
            const { searchParams } = new URL(req.url);
            const workspaceId = searchParams.get('workspaceId') || undefined;
            const all = mockListDocs({
                workspaceId: workspaceId || undefined,
                ownerId: auth.uid
            });
            return NextResponse.json(all, { headers: { 'Cache-Control': 'no-store' } });
        }

        const { searchParams } = new URL(req.url);
        const workspaceId = searchParams.get('workspaceId');
        const view = searchParams.get('view');
        const fieldsParam = searchParams.get('fields');
        const rawSearch = searchParams.get('q');
        const searchQuery = rawSearch ? rawSearch.trim().toLowerCase() : '';

        let q: FirebaseFirestore.Query = adminDb.collection('documents');

        if (workspaceId && !isPersonalWorkspaceId(workspaceId)) {
            const member = await isWorkspaceMember(workspaceId, auth.uid);
            if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            q = q.where('workspaceId', '==', workspaceId);
        } else {
            q = q.where('ownerId', '==', auth.uid);
            if (workspaceId === PERSONAL_WORKSPACE_ID) {
                q = q.where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
            }
        }

        const isMetadataView = view === 'metadata' || view === 'list' || view !== 'full';
        if (isMetadataView) {
            const defaultFields = [
                'name', 'type', 'mimeType', 'folder',
                'workspaceId', 'ownerId', 'order', 'url',
                'storagePath', 'storageBackend', 'contentHash', 'version', 'syncState',
                'sourceName', 'sourceMimeType', 'sourceStoragePath', 'sourceUrl', 'sourceFormat',
                'updatedAt', 'createdAt', 'size'
            ];
            const fields = fieldsParam
                ? fieldsParam.split(',').map(part => part.trim()).filter(Boolean)
                : defaultFields;
            // Firestore no soporta substring nativo. Si hay `q`, traemos
            // `searchableContent` para filtrar in-memory aunque el cliente
            // no lo pida en `fields` — lo descartamos antes del response.
            const effectiveFields = searchQuery
                ? Array.from(new Set([...fields, 'searchableContent']))
                : Array.from(new Set(fields));
            if (effectiveFields.length > 0) {
                q = q.select(...effectiveFields);
            }
        }

        const limitParam = searchParams.get('limit');
        const offsetParam = searchParams.get('offset');
        const cursorParam = searchParams.get('cursor');
        const limitVal = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 10000) : 5000;

        const orderedQ = q.orderBy('updatedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
        let paginatedQ: FirebaseFirestore.Query = orderedQ;
        if (cursorParam) {
            const cursor = decodeDocumentsCursor(cursorParam);
            if (cursor) {
                const cursorSnap = await adminDb.collection('documents').doc(cursor.id).get();
                if (cursorSnap.exists) {
                    paginatedQ = orderedQ.startAfter(cursorSnap);
                } else {
                    const cursorTs = new Date(cursor.updatedAtMs);
                    paginatedQ = orderedQ.startAfter(cursorTs, cursor.id);
                }
            }
        }

        const snapshot = await paginatedQ.limit(limitVal).get();
        let lastUpdatedMs: number | null = null;
        let docs = snapshot.docs.map(doc => {
            const data = doc.data() as Record<string, unknown>;
            const raw: Record<string, unknown> = { id: doc.id, ...data };
            normalizeDotfileLegacy(raw);
            // El url firmado guardado puede apuntar a un host de storage muerto
            // (Firebase Storage legacy o s3.proxy.humanizar-dev.cloud pre-migración).
            // Si no coincide con el endpoint MinIO actual, lo descartamos: el
            // viewer pide /api/documents/[id] y obtiene una URL fresca on-read.
            if (isStaleBlobUrl(raw.url)) {
                delete raw.url;
            }
            const updatedAt = data.updatedAt as { toMillis?: () => number } | undefined;
            if (updatedAt && typeof updatedAt.toMillis === 'function') {
                lastUpdatedMs = updatedAt.toMillis();
            }
            return raw;
        });

        if (searchQuery) {
            // Firestore no soporta substring; filtramos in-memory por `name`
            // y `searchableContent` (todos los tokens deben aparecer).
            const tokens = searchQuery.split(/\s+/).filter((tok) => tok.length >= 2);
            const matchTokens = tokens.length > 0 ? tokens : [searchQuery];
            docs = docs.filter((raw) => {
                const name = typeof raw.name === 'string' ? raw.name.toLowerCase() : '';
                const searchable = typeof raw.searchableContent === 'string' ? raw.searchableContent.toLowerCase() : '';
                const folder = typeof raw.folder === 'string' ? raw.folder.toLowerCase() : '';
                const haystack = `${name}\n${folder}\n${searchable}`;
                return matchTokens.every((tok) => haystack.includes(tok));
            });
            // No exponer `searchableContent` en el response — el cliente no lo
            // pidió (no estaba en defaultFields ni en fieldsParam).
            const fieldsRequested = fieldsParam
                ? fieldsParam.split(',').map((p) => p.trim()).filter(Boolean)
                : null;
            const clientWantsSearchable = fieldsRequested
                ? fieldsRequested.includes('searchableContent')
                : false;
            if (!clientWantsSearchable) {
                for (const raw of docs) delete raw.searchableContent;
            }
        }

        if (offsetParam && !cursorParam) {
            const offsetVal = Math.max(0, parseInt(offsetParam, 10));
            docs = docs.slice(offsetVal);
        }

        const lastDoc = snapshot.docs[snapshot.docs.length - 1];
        const nextCursor = snapshot.docs.length === limitVal && lastDoc && lastUpdatedMs !== null
            ? encodeDocumentsCursor({ updatedAtMs: lastUpdatedMs, id: lastDoc.id })
            : null;

        const cacheControl = isMetadataView
            ? 'private, max-age=0, stale-while-revalidate=5'
            : 'no-store, no-cache, must-revalidate, proxy-revalidate';

        const headers: Record<string, string> = { 'Cache-Control': cacheControl };
        if (nextCursor) headers['X-Next-Cursor'] = nextCursor;
        return NextResponse.json(docs, { headers });
    } catch (error: unknown) {
        console.error('Error listing documents:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
