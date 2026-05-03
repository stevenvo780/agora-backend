/**
 * GET /api/workspaces/[id]/git/status
 * Compara docs del workspace vs último commit del repo.
 * Optimizado: 1 sola llamada `listRepoTree` a Forgejo (no N getFileMeta).
 * No descarga blobs en MinIO — eso solo ocurre en /commit.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { adminDb } from '@/lib/firebase-admin';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import { isForgejoConfigured, repoNameForWorkspace, getForgejoOrg } from '@/lib/forgejo';
import { listRepoTree } from '@/lib/forgejo-git';
import { buildRepoPath } from '@/lib/forgejo-path';
import { loadWorkspaceIgnore, isIgnoredPath } from '@/lib/forgejo-ignore';
import { getErrorMessage } from '@/lib/error-utils';

export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
    try {
        if (!isForgejoConfigured()) return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id: workspaceId } = await context.params;

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

        // 1) Lista de docs del workspace (Firestore).
        let docsQuery: FirebaseFirestore.Query = adminDb.collection('documents');
        if (isPersonalWorkspaceId(workspaceId)) {
            docsQuery = docsQuery
                .where('ownerId', '==', auth.uid)
                .where('workspaceId', '==', PERSONAL_WORKSPACE_ID);
        } else {
            docsQuery = docsQuery.where('workspaceId', '==', workspaceId);
        }
        const docs = await docsQuery
            .select('name', 'folder', 'storagePath', 'contentHash', 'size', 'type', 'git')
            .limit(500)
            .get();

        // 2) Single tree fetch del repo Forgejo.
        let repoTree = new Map<string, string>();
        try {
            repoTree = await listRepoTree(repoFullName, 'main');
        } catch (e) {
            console.warn('[git/status] listRepoTree failed:', getErrorMessage(e));
        }

        // 3) Cargar reglas .gitignore del workspace (defaults razonables incluidos).
        const ig = await loadWorkspaceIgnore(docsQuery);

        // 4) Procesar en memoria, sin descargar blobs. Filtrar:
        //    - folders (no son archivos commiteables)
        //    - docs sin storagePath (huérfanos)
        //    - paths que matchean .gitignore (node_modules/, .env, etc.)
        const items = docs.docs
            .filter(d => {
                const data = d.data() as { type?: string; storagePath?: string; name?: string; folder?: string };
                if (data.type === 'folder') return false;
                if (typeof data.storagePath !== 'string' || data.storagePath.length === 0) return false;
                const repoPath = buildRepoPath(data.folder, data.name);
                return !isIgnoredPath(ig, repoPath);
            })
            .map((d) => {
                const data = d.data() as {
                    name?: string;
                    folder?: string;
                    storagePath?: string;
                    contentHash?: string;
                    size?: number;
                    type?: string;
                    git?: { committedHash?: string; lastSha?: string };
                };
                const repoPath = buildRepoPath(data.folder, data.name);
                const committedHash = data.git?.committedHash ?? null;
                const currentHash = data.contentHash ?? null;
                const remoteSha = repoTree.get(repoPath) ?? null;

                let status: 'clean' | 'modified' | 'new' | 'unknown';
                if (committedHash && currentHash) {
                    status = committedHash === currentHash ? 'clean' : 'modified';
                } else if (currentHash && remoteSha) {
                    // Tenemos hash local pero el doc nunca registró committedHash.
                    // Heurística: si está en el repo, lo tratamos como modified (lo
                    // marcaremos clean al hacer commit explícito).
                    status = 'modified';
                } else if (!currentHash) {
                    // Sin contentHash en Firestore (migración vieja). No descargamos
                    // el blob aquí — se calcula al hacer commit. Mostramos como
                    // candidato a commit con etiqueta `unknown`.
                    status = remoteSha ? 'modified' : 'new';
                } else {
                    status = 'new';
                }

                return {
                    docId: d.id,
                    repoPath,
                    name: data.name ?? null,
                    folder: data.folder ?? null,
                    size: data.size ?? null,
                    type: data.type ?? null,
                    currentHash,
                    committedHash,
                    lastSha: data.git?.lastSha ?? remoteSha,
                    status
                };
            });

        return NextResponse.json({
            workspaceId,
            repoFullName,
            items: items.sort((a, b) => (a.repoPath > b.repoPath ? 1 : -1))
        });
    } catch (e) {
        const err = e as Error;
        console.error('[git/status] error:', err?.message);
        return NextResponse.json({ error: getErrorMessage(e), detail: err?.stack?.split('\n').slice(0, 3).join(' | ') }, { status: 500 });
    }
}
