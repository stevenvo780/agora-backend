/**
 * POST /api/workspaces/[id]/git/commit
 * Body: { message: string, docIds: string[] }
 * Toma los docs por id, lee su blob actual de MinIO y hace PUT/POST a Forgejo.
 * Tras el commit, actualiza Firestore: documents/<id>.git.committedHash + lastSha.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { adminAuth, adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { isForgejoConfigured, repoNameForWorkspace, getForgejoOrg, userLoginFor } from '@/lib/forgejo';
import { listRepoTree, applyCommit, type CommitChange } from '@/lib/forgejo-git';
import { buildRepoPath } from '@/lib/forgejo-path';
import { loadWorkspaceIgnore, isIgnoredPath } from '@/lib/forgejo-ignore';
import { isNasConfigured, getObjectBuffer } from '@/lib/nas-storage';
import { getErrorMessage } from '@/lib/error-utils';
import crypto from 'node:crypto';

export const maxDuration = 800;
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        if (!isForgejoConfigured()) return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        if (!isNasConfigured()) return NextResponse.json({ error: 'NAS storage not configured' }, { status: 503 });
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id: workspaceId } = await context.params;
        const body = (await req.json()) as { message?: unknown; docIds?: unknown };
        const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : `Update ${new Date().toISOString()}`;
        const docIds = Array.isArray(body.docIds) ? body.docIds.filter((x): x is string => typeof x === 'string') : [];
        if (docIds.length === 0) return NextResponse.json({ error: 'docIds required' }, { status: 400 });

        // ACL
        let ownerUid = auth.uid;
        if (!isPersonalWorkspaceId(workspaceId)) {
            const ws = await adminDb.collection('workspaces').doc(workspaceId).get();
            if (!ws.exists) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
            const data = ws.data() as { ownerId?: string; members?: string[] } | undefined;
            const ok = (data?.members ?? []).includes(auth.uid)
                || data?.ownerId === auth.uid
                || await isWorkspaceMember(workspaceId, auth.uid);
            if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            ownerUid = data?.ownerId ?? auth.uid;
        }

        const repoName = repoNameForWorkspace(workspaceId, ownerUid);
        const repoFullName = `${getForgejoOrg()}/${repoName}`;

        // Obtener autor email (Firebase Auth o noreply)
        let authorEmail: string | undefined;
        try { authorEmail = (await adminAuth.getUser(auth.uid)).email ?? undefined; } catch { /* insecure */ }
        const authorName = userLoginFor(auth.uid);

        // Cargar docs y construir changes
        const refs = docIds.map((id) => adminDb.collection('documents').doc(id));
        const snaps = await adminDb.getAll(...refs);
        const changes: CommitChange[] = [];
        const planned: { docId: string; repoPath: string; ref: typeof refs[number] }[] = [];

        // Filtrar antes de descargar buffers evita gastar MinIO+Forgejo en
        // archivos ignorados aunque el cliente los seleccione.
        let docsQuery: FirebaseFirestore.Query = adminDb.collection('documents');
        if (isPersonalWorkspaceId(workspaceId)) {
            docsQuery = docsQuery
                .where('ownerId', '==', auth.uid)
                .where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
        } else {
            docsQuery = docsQuery.where('workspaceId', '==', workspaceId);
        }
        const ig = await loadWorkspaceIgnore(docsQuery);

        let preTree = new Map<string, string>();
        try {
            preTree = await listRepoTree(repoFullName, 'main');
        } catch (e) {
            console.warn('[git/commit] preTree fetch failed (repo recién creado?):', (e as Error).message);
        }

        // Concurrencia limitada solo para descargas MinIO (no Forgejo).
        const BATCH = 8;
        let skippedIgnored = 0;
        const candidates = snaps.filter(s => s.exists).map(s => ({ snap: s, data: s.data() as {
            workspaceId?: string; ownerId?: string; name?: string; folder?: string;
            storagePath?: string; git?: { lastSha?: string };
        } })).filter(({ data }) => {
            if (!data.storagePath) return true;
            const repoPath = buildRepoPath(data.folder, data.name);
            if (isIgnoredPath(ig, repoPath)) { skippedIgnored++; return false; }
            return true;
        });

        for (let i = 0; i < candidates.length; i += BATCH) {
            const batch = candidates.slice(i, i + BATCH);
            const built = await Promise.all(batch.map(async ({ snap, data }) => {
                const wsMatches = isPersonalWorkspaceId(workspaceId)
                    ? (data.workspaceId === PERSONAL_WORKSPACE_ID && data.ownerId === auth.uid)
                    : data.workspaceId === workspaceId;
                if (!wsMatches) return null;
                if (!data.storagePath) return null;

                const repoPath = buildRepoPath(data.folder, data.name);
                const buf = await getObjectBuffer(data.storagePath);
                if (!buf) return null;

                const shaIfUpdate: string | undefined = data.git?.lastSha ?? preTree.get(repoPath);
                return { snap, repoPath, change: {
                    path: repoPath,
                    content: buf,
                    operation: shaIfUpdate ? 'update' as const : 'create' as const,
                    ...(shaIfUpdate ? { shaIfUpdate } : {})
                } };
            }));
            for (const item of built) {
                if (!item) continue;
                changes.push(item.change as CommitChange);
                planned.push({ docId: item.snap.id, repoPath: item.repoPath, ref: item.snap.ref });
            }
        }

        if (changes.length === 0) {
            return NextResponse.json({ error: 'No hay archivos para commitear' }, { status: 400 });
        }

        // SSE: text/event-stream evita buffering del proxy de Vercel.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const send = (obj: unknown) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
                };
                send({ event: 'connected', ts: Date.now(), skippedIgnored });
                // El proxy necesita ~2KB antes de empezar a flushear.
                controller.enqueue(encoder.encode(`: ${' '.repeat(2048)}\n\n`));

                const heartbeat = setInterval(() => {
                    try { controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`)); } catch { /* closed */ }
                }, 10_000);

                (async () => {
                    try {
                        const result = await applyCommit({
                            repoFullName,
                            branch: 'main',
                            message,
                            changes,
                            authorName,
                            authorEmail,
                            onProgress: (ev) => send({
                                event: 'progress',
                                ...ev,
                                // compat: el cliente actual lee totalChunks; ahora 1
                                // commit = 1 chunk lógico, así que reportamos 1.
                                totalChunks: 1
                            })
                        });

                        const okPaths = new Set(planned.map(p => p.repoPath).filter(p => !result.errors.some(e => e.path === p)));
                        send({ event: 'persist', total: okPaths.size });
                        let postTree = new Map<string, string>();
                        try {
                            postTree = await listRepoTree(repoFullName, 'main');
                        } catch (err) {
                            console.warn('[git/commit] postTree fetch failed:', (err as Error).message);
                        }
                        let persisted = 0;
                        for (let i = 0; i < planned.length; i++) {
                            const p = planned[i];
                            if (!okPaths.has(p.repoPath)) continue;
                            try {
                                const treeSha = postTree.get(p.repoPath);
                                const change = changes[i];
                                const buf = (change as { content?: Buffer }).content;
                                const computedHash = buf ? crypto.createHash('sha256').update(buf).digest('hex') : null;
                                await p.ref.set({
                                    contentHash: computedHash ?? FieldValue.delete(),
                                    size: buf ? buf.length : FieldValue.delete(),
                                    git: {
                                        committedHash: computedHash,
                                        lastSha: treeSha ?? null,
                                        repoFullName,
                                        lastCommitMessage: message,
                                        lastCommitAt: FieldValue.serverTimestamp()
                                    }
                                }, { merge: true });
                                persisted++;
                                if (persisted % 25 === 0) send({ event: 'persist-progress', persisted, total: okPaths.size });
                            } catch (err) {
                                console.warn('[git/commit] persist failed for', p.repoPath, (err as Error).message);
                            }
                        }
                        send({ event: 'persist-progress', persisted, total: okPaths.size });

                        send({
                            event: 'done',
                            ok: result.ok,
                            committedCount: changes.length - result.errors.length,
                            failedCount: result.errors.length,
                            errors: result.errors,
                            newCommitSha: result.newSha ?? null,
                            message
                        });
                        clearInterval(heartbeat);
                        controller.close();
                    } catch (e) {
                        const err = e as Error;
                        send({ event: 'error', error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
                        clearInterval(heartbeat);
                        controller.close();
                    }
                })();
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-store, no-transform, no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            }
        });
    } catch (e) {
        const err = e as Error;
        console.error('[git/commit] error:', err?.message, err?.stack);
        return NextResponse.json({ error: getErrorMessage(e), detail: err?.stack?.split('\n').slice(0, 3).join(' | ') }, { status: 500 });
    }
}
