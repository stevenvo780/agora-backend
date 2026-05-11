/**
 * POST /api/sync/worker-commit
 * Body: { repoPath: string, contentHash: string, size: number, mimeType?: string }
 *
 * El worker ya subió el blob al storagePath = `workspaces/<wsId>/<repoPath>`.
 * Esta ruta:
 *   1) Busca el doc Firestore por (workspaceId, name, folder). Si existe → UPDATE
 *      (bumpea version, contentHash, size, syncState). Si no → CREATE con
 *      ownerId derivado del workspace owner.
 *   2) Verifica que el blob exista en MinIO.
 *   3) Emite ping RTDB para que el cliente web refresque.
 *
 * Auth: HMAC worker (sólo para workspaces compartidos por ahora).
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { verifyWorkerAuth } from '@/lib/worker-auth';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { objectExists, deleteObject, isNasConfigured, getObjectBuffer } from '@/lib/nas-storage';
import { enforceStorageQuota } from '@/lib/plan-guard';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { emitPing } from '@/lib/nas-events';
import { getErrorMessage } from '@/lib/error-utils';
import { parseWorkerCommitPayload, splitRepoPath } from '@agora/contracts';
import { computeSearchableContent } from '@/lib/search/searchable-content';
import { invalidateAgoraWorkspaceContext } from '@/lib/agora-ai/context';
import { invalidateStorageUsageCache } from '@/lib/storage-usage';

const TEXT_EXT = new Set([
    '.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.toml', '.ini',
    '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
    '.sh', '.bash', '.zsh', '.fish', '.env', '.conf', '.cfg', '.diff', '.patch',
    '.st', '.sql', '.gitattributes', '.gitconfig', '.editorconfig'
]);

const inferType = (name: string, mimeType?: string): { type: string; mimeType: string } => {
    const lower = name.toLowerCase();
    // Dotfiles tipo .syncignore, .gitignore, .env, .npmrc — son texto plano.
    if (lower.startsWith('.') && lower.indexOf('.', 1) === -1) {
        return { type: 'text', mimeType: mimeType ?? 'text/plain' };
    }
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return { type: 'text', mimeType: mimeType ?? 'text/markdown' };
    if (lower.endsWith('.json')) return { type: 'text', mimeType: mimeType ?? 'application/json' };
    const dotIdx = lower.lastIndexOf('.');
    const ext = dotIdx >= 0 ? lower.slice(dotIdx) : '';
    if (TEXT_EXT.has(ext)) return { type: 'text', mimeType: mimeType ?? 'text/plain' };
    return { type: 'file', mimeType: mimeType ?? 'application/octet-stream' };
};

export async function POST(req: NextRequest) {
    try {
        if (!isNasConfigured()) return NextResponse.json({ error: 'NAS not configured' }, { status: 503 });
        const ctx = verifyWorkerAuth(req);
        if (!ctx) return NextResponse.json({ error: 'Worker auth required' }, { status: 401 });
        const isPersonal = isPersonalWorkspaceId(ctx.workspaceId);
        if (isPersonal && !ctx.userId) {
            return NextResponse.json({ error: 'Personal workspace requires X-Worker-Uid' }, { status: 400 });
        }

        const body = await req.json().catch(() => null);
        const parsed = parseWorkerCommitPayload(body);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        const { repoPath, contentHash, size, mimeType } = parsed.value;

        const storagePath = isPersonal
            ? `users/${ctx.userId}/${repoPath}`
            : `workspaces/${ctx.workspaceId}/${repoPath}`;
        if (!(await objectExists(storagePath))) {
            return NextResponse.json({ error: 'Blob not found in NAS — upload first' }, { status: 412 });
        }

        const { folder, name } = splitRepoPath(repoPath);
        const { type: inferredType, mimeType: inferredMime } = inferType(name, mimeType ?? undefined);

        const MAX_SEARCHABLE_FETCH_BYTES = 256 * 1024;
        const lowerName = name.toLowerCase();
        const isMarkdownLike = inferredType === 'text'
            && (inferredMime === 'text/markdown' || lowerName.endsWith('.md') || lowerName.endsWith('.markdown'));
        let searchable: string | null = null;
        if (isMarkdownLike && (size === null || size === undefined || size <= MAX_SEARCHABLE_FETCH_BYTES)) {
            try {
                const buf = await getObjectBuffer(storagePath);
                if (buf) {
                    const text = buf.subarray(0, MAX_SEARCHABLE_FETCH_BYTES).toString('utf8');
                    const computed = computeSearchableContent(text);
                    if (computed.length > 0) searchable = computed;
                }
            } catch (err) {
                console.warn('[sync/worker-commit] searchable compute failed:', getErrorMessage(err));
            }
        }

        const existingQueryBuilder = (): FirebaseFirestore.Query => isPersonal
            ? adminDb.collection('documents')
                .where('ownerId', '==', ctx.userId)
                .where('workspaceId', '==', PERSONAL_WORKSPACE_ID)
                .where('name', '==', name)
                .where('folder', '==', folder)
            : adminDb.collection('documents')
                .where('workspaceId', '==', ctx.workspaceId)
                .where('name', '==', name)
                .where('folder', '==', folder);
        const preSnap = await existingQueryBuilder().limit(1).get();

        // Owner para cuota — en personal es el propio uid; en shared es ownerId del workspace.
        let wsOwner = ctx.userId ?? '';
        if (!isPersonal) {
            const wsSnapEarly = await adminDb.collection('workspaces').doc(ctx.workspaceId).get();
            wsOwner = (wsSnapEarly.data() as { ownerId?: string } | undefined)?.ownerId ?? '';
        }
        if (!wsOwner) {
            await deleteObject(storagePath).catch(() => undefined);
            return NextResponse.json({ error: 'Owner not resolvable' }, { status: 500 });
        }
        if (size && size > 0) {
            // Para updates, descontar el size del doc existente (no double-count).
            const oldSize = preSnap.empty ? 0 : Number((preSnap.docs[0]!.data() as { size?: number }).size ?? 0);
            const delta = Math.max(0, size - oldSize);
            const quotaResp = await enforceStorageQuota(wsOwner, delta);
            if (quotaResp) {
                await deleteObject(storagePath).catch(() => undefined);
                return quotaResp;
            }
        }

        const txResult = await adminDb.runTransaction<{ docId: string; version: number; created: boolean }>(async (tx) => {
            const inTxSnap = await tx.get(existingQueryBuilder().limit(1));
            if (!inTxSnap.empty) {
                const ref = inTxSnap.docs[0]!.ref;
                const cur = inTxSnap.docs[0]!.data() as { version?: number };
                const currentVersion = typeof cur.version === 'number' ? cur.version : 0;
                const nextVersion = currentVersion + 1;
                const updatePayload: Record<string, unknown> = {
                    contentHash,
                    size: size ?? FieldValue.delete(),
                    version: nextVersion,
                    baseVersion: currentVersion,
                    syncState: 'synced',
                    lastWriter: `worker:${ctx.workspaceId}`,
                    storagePath,
                    storageBackend: 'minio',
                    mimeType: inferredMime,
                    content: FieldValue.delete(),
                    updatedAt: FieldValue.serverTimestamp()
                };
                if (isMarkdownLike) {
                    updatePayload.searchableContent = searchable !== null ? searchable : FieldValue.delete();
                }
                tx.update(ref, updatePayload);
                return { docId: ref.id, version: nextVersion, created: false };
            }

            const ref = adminDb.collection('documents').doc();
            const docPayload: Record<string, unknown> = {
                name,
                folder,
                type: inferredType,
                mimeType: inferredMime,
                workspaceId: isPersonal ? PERSONAL_WORKSPACE_ID : ctx.workspaceId,
                ownerId: wsOwner,
                storagePath,
                storageBackend: 'minio',
                contentHash,
                size: size ?? null,
                version: 1,
                baseVersion: 0,
                syncState: 'synced',
                lastWriter: `worker:${ctx.workspaceId}`,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
            };
            if (searchable !== null) docPayload.searchableContent = searchable;
            tx.create(ref, docPayload);
            return { docId: ref.id, version: 1, created: true };
        });

        const docId = txResult.docId;
        const version = txResult.version;
        const created = txResult.created;

        invalidateAgoraWorkspaceContext(ctx.workspaceId);
        invalidateStorageUsageCache(wsOwner);

        await emitPing({
            scope: 'document',
            op: created ? 'created' : 'updated',
            workspaceId: ctx.workspaceId,
            docId,
            path: storagePath,
            folder,
            version,
            contentHash,
            sender: `worker:${ctx.workspaceId}`
        }).catch(() => undefined);

        return NextResponse.json({ docId, version, contentHash, created });
    } catch (e) {
        console.error('[sync/worker-commit] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
