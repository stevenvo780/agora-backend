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

export const maxDuration = 800;
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// Commit-en-VPS: en vez de leer los blobs acá (Cloud Run, RAM limitada → OOM con
// commits grandes) y mandar el body entero a Forgejo, le mandamos al Hub (en
// agora-storage, junto a MinIO+Forgejo locales) solo la LISTA de archivos; el Hub
// lee los blobs local + pushea local. Si el Hub no responde, caemos al path
// in-process (fallback), así nunca rompemos commits chicos.
const HUB_URL = (process.env.NEXUS_URL || 'https://hub.elenxos.com').replace(/\/$/, '');
const HUB_SECRET = (process.env.HUB_INTERNAL_SECRET || process.env.BACKEND_INTERNAL_SECRET || '').trim();
interface HubCommitFile { repoPath: string; operation: 'create' | 'update' | 'delete'; storagePath?: string; sha?: string }
const commitViaHub = async (params: {
    repoFullName: string; message: string; files: HubCommitFile[]; authorName?: string; authorEmail?: string;
}): Promise<{ ok: boolean; sha?: string } | null> => {
    if (!HUB_SECRET) return null;
    try {
        const res = await fetch(`${HUB_URL}/internal/git-commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-hub-internal-secret': HUB_SECRET },
            body: JSON.stringify({ repoFullName: params.repoFullName, branch: 'main', message: params.message, authorName: params.authorName, authorEmail: params.authorEmail, files: params.files })
        });
        if (!res.ok) { console.warn('[git/commit] hub commit HTTP', res.status); return null; }
        const j = await res.json() as { ok?: boolean; sha?: string };
        return j.ok ? { ok: true, sha: j.sha } : null;
    } catch (e) {
        console.warn('[git/commit] hub commit fallback:', (e as Error).message);
        return null;
    }
};

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
        const planned: { docId: string; repoPath: string; ref: typeof refs[number]; contentHash: string | null }[] = [];
        const hubFiles: HubCommitFile[] = [];

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

        const BATCH = 8;
        let skippedIgnored = 0;
        const candidates = snaps.filter(s => s.exists).map(s => ({ snap: s, data: s.data() as {
            workspaceId?: string; ownerId?: string; name?: string; folder?: string;
            storagePath?: string; contentHash?: string; git?: { lastSha?: string };
        } })).filter(({ data }) => {
            if (!data.storagePath) return true;
            const repoPath = buildRepoPath(data.folder, data.name);
            if (isIgnoredPath(ig, repoPath)) { skippedIgnored++; return false; }
            return true;
        });

        // Lista de archivos (metadata, SIN leer blobs) → se la mandamos al Hub.
        const fileMeta: { storagePath: string; repoPath: string; operation: 'create' | 'update'; sha?: string }[] = [];
        for (const { snap, data } of candidates) {
            const wsMatches = isPersonalWorkspaceId(workspaceId)
                ? (data.workspaceId === PERSONAL_WORKSPACE_ID && data.ownerId === auth.uid)
                : data.workspaceId === workspaceId;
            if (!wsMatches || !data.storagePath) continue;
            const repoPath = buildRepoPath(data.folder, data.name);
            const shaIfUpdate: string | undefined = data.git?.lastSha ?? preTree.get(repoPath);
            const operation = shaIfUpdate ? 'update' as const : 'create' as const;
            fileMeta.push({ storagePath: data.storagePath, repoPath, operation, ...(shaIfUpdate ? { sha: shaIfUpdate } : {}) });
            hubFiles.push({ repoPath, operation, storagePath: data.storagePath, ...(shaIfUpdate ? { sha: shaIfUpdate } : {}) });
            planned.push({ docId: snap.id, repoPath, ref: snap.ref, contentHash: data.contentHash ?? null });
        }

        if (fileMeta.length === 0) {
            return NextResponse.json({ error: 'No hay archivos para commitear' }, { status: 400 });
        }

        // Fallback (solo si el Hub no responde): leer los blobs de MinIO acá y
        // commitear in-process. Path original — bufferea en Cloud Run (puede OOM
        // con commits grandes), por eso el Hub es el camino primario.
        const buildChangesFromBlobs = async (): Promise<CommitChange[]> => {
            const ch: CommitChange[] = [];
            for (let i = 0; i < fileMeta.length; i += BATCH) {
                const batch = fileMeta.slice(i, i + BATCH);
                const built = await Promise.all(batch.map(async (f) => {
                    const buf = await getObjectBuffer(f.storagePath);
                    if (!buf) return null;
                    return { path: f.repoPath, content: buf, operation: f.operation, ...(f.sha ? { shaIfUpdate: f.sha } : {}) } as CommitChange;
                }));
                for (const c of built) if (c) ch.push(c);
            }
            return ch;
        };

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
                        let result: { ok: boolean; newSha?: string; errors: { path: string }[] };
                        const totalFiles = hubFiles.length;
                        // Camino PRIMARIO: commit-en-VPS (Hub lee MinIO local + pushea
                        // Forgejo local). Sin leer blobs acá → sin OOM en Cloud Run.
                        const hubRes = await commitViaHub({ repoFullName, message, files: hubFiles, authorName, authorEmail });
                        if (hubRes && hubRes.ok) {
                            result = { ok: true, newSha: hubRes.sha, errors: [] };
                            send({ event: 'progress', kind: 'done', via: 'vps-hub', totalFiles, totalChunks: 1 });
                        } else {
                            // Fallback in-process (Hub caído): leer blobs + commit acá.
                            send({ event: 'progress', kind: 'fallback', note: 'commit en backend (Hub no disponible)', totalFiles, totalChunks: 1 });
                            const changes = await buildChangesFromBlobs();
                            const r = await applyCommit({
                                repoFullName, branch: 'main', message, changes, authorName, authorEmail,
                                onProgress: (ev) => send({ event: 'progress', ...ev, totalChunks: 1 })
                            });
                            result = { ok: r.ok, newSha: r.newSha, errors: r.errors };
                        }

                        const okPaths = new Set(planned.map(p => p.repoPath).filter(p => !result.errors.some(e => e.path === p)));
                        send({ event: 'persist', total: okPaths.size });
                        let postTree = new Map<string, string>();
                        try {
                            postTree = await listRepoTree(repoFullName, 'main');
                        } catch (err) {
                            console.warn('[git/commit] postTree fetch failed:', (err as Error).message);
                        }
                        let persisted = 0;
                        for (const p of planned) {
                            if (!okPaths.has(p.repoPath)) continue;
                            try {
                                const treeSha = postTree.get(p.repoPath);
                                // El commit no cambia el contenido: conservamos el contentHash
                                // del doc (ya correcto del sync) y solo registramos git.lastSha.
                                await p.ref.set({
                                    git: {
                                        committedHash: p.contentHash,
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
                            committedCount: okPaths.size,
                            failedCount: result.errors.length,
                            errors: result.errors,
                            newCommitSha: result.newSha ?? null,
                            message
                        });
                        clearInterval(heartbeat);
                        controller.close();
                    } catch (e) {
                        console.error('[git/commit] stream error', e);
                        const err = e as Error;
                        send({ event: 'error', error: err.message });
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
        console.error('[git/commit] error', e);
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
