/**
 * /api/documents
 * GET (list) / POST (create) — Firestore metadata + MinIO blobs.
 * `documents.content` ya no se persiste.
 */
import { env } from '@/lib/env';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { enforceStorageQuota } from '@/lib/plan-guard';
import { normalizeFolderPath } from '@/lib/folder-utils';
import { buildStoragePath, ensureTextFileName } from '@/lib/storage-path';
import { DocumentType } from '@/types/documents';
import { PERSONAL_WORKSPACE_ID, isPersonalWorkspaceId } from '@/types/workspace';
import { mockCreateDoc, mockListDocs } from '@/lib/insecure-mock-store';
import { isNasConfigured, putObject } from '@/lib/nas-storage';
import { emitPing } from '@/lib/nas-events';
import { normalizeDotfileLegacy, parseDocumentCreatePayload } from '@agora/contracts';

const isInsecure = env.ALLOW_INSECURE_AUTH();

export async function POST(req: NextRequest) {
    try {
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        if (isInsecure) {
            const body = (await req.json()) as Record<string, unknown>;
            const folder = normalizeFolderPath(typeof body.folder === 'string' ? body.folder : undefined);
            const doc = mockCreateDoc({
                name: typeof body.name === 'string' && body.name.trim() ? body.name : 'Sin titulo',
                content: typeof body.content === 'string' ? body.content : '',
                type: typeof body.type === 'string' ? body.type : DocumentType.Text,
                workspaceId: typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : PERSONAL_WORKSPACE_ID,
                folder,
                ownerId: auth.uid,
                mimeType: typeof body.mimeType === 'string' ? body.mimeType : null,
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
        const docName = name;
        const docType = type;

        if (!isPersonalWorkspaceId(resolvedWorkspaceId)) {
            const member = await isWorkspaceMember(resolvedWorkspaceId, auth.uid);
            if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const allowedPrefix = isPersonalWorkspaceId(resolvedWorkspaceId)
            ? `users/${ownerId}/`
            : `workspaces/${resolvedWorkspaceId}/`;
        if (storagePath && !storagePath.startsWith(allowedPrefix)) {
            return NextResponse.json({ error: 'Invalid storagePath' }, { status: 403 });
        }

        let finalStoragePath = storagePath ?? undefined;
        let contentHash: string | null = null;
        let size: number | null = null;

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
            if (content !== null) {
                const incomingBytes = Buffer.byteLength(content, 'utf8');
                const quotaResp = await enforceStorageQuota(ownerId, incomingBytes);
                if (quotaResp) return quotaResp;
                const ext = (finalStoragePath.match(/\.[^./]+$/)?.[0] ?? '').toLowerCase();
                const ct = ext === '.md' || ext === '.markdown'
                    ? 'text/markdown'
                    : (mimeType ?? 'text/plain');
                const out = await putObject(finalStoragePath, content, {
                    contentType: ct,
                    metadata: { 'agora-source': 'api-create', 'agora-owner': ownerId }
                });
                contentHash = out.contentHash;
                size = out.size;
            }
        }

        const docData: Record<string, unknown> = {
            name: docName,
            type: docType,
            mimeType: mimeType ?? null,
            ownerId,
            workspaceId: resolvedWorkspaceId,
            folder: normalizedFolder,
            storageBackend: 'minio',
            version: 1,
            baseVersion: 0,
            syncState: 'synced',
            lastWriter: ownerId,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        };
        if (order !== null) docData.order = order;
        if (finalStoragePath) docData.storagePath = finalStoragePath;
        if (contentHash) docData.contentHash = contentHash;
        if (size !== null) docData.size = size;
        if (url && finalStoragePath) docData.url = url;

        const ref = await adminDb.collection('documents').add(docData);

        await emitPing({
            scope: 'document',
            workspaceId: resolvedWorkspaceId,
            userId: ownerId,
            docId: ref.id,
            path: finalStoragePath ?? null,
            version: 1,
            contentHash,
            sender: ownerId
        }).catch(() => undefined);

        return NextResponse.json({
            id: ref.id,
            status: 'success',
            storagePath: finalStoragePath,
            storageBackend: 'minio',
            version: 1,
            contentHash
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
            const uniqueFields = Array.from(new Set(fields));
            if (uniqueFields.length > 0) {
                q = q.select(...uniqueFields);
            }
        }

        const limitParam = searchParams.get('limit');
        const offsetParam = searchParams.get('offset');
        const limitVal = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 1000) : 1000;
        const snapshot = await q.limit(limitVal).get();
        let docs = snapshot.docs.map(doc => {
            const raw: Record<string, unknown> = { id: doc.id, ...(doc.data() as Record<string, unknown>) };
            normalizeDotfileLegacy(raw);
            return raw;
        });
        if (offsetParam) {
            const offsetVal = Math.max(0, parseInt(offsetParam, 10));
            docs = docs.slice(offsetVal);
        }

        const cacheControl = isMetadataView
            ? 'private, max-age=0, stale-while-revalidate=5'
            : 'no-store, no-cache, must-revalidate, proxy-revalidate';

        return NextResponse.json(docs, { headers: { 'Cache-Control': cacheControl } });
    } catch (error: unknown) {
        console.error('Error listing documents:', getErrorMessage(error));
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
