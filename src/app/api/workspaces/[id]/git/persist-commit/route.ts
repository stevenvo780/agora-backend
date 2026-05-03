/**
 * POST /api/workspaces/[id]/git/persist-commit
 *
 * El cliente acaba de hacer commit DIRECTO a Forgejo (sin pasar por Vercel).
 * Aquí solo persistimos los metadata Firestore: para cada docId committeado,
 * actualizamos `git.committedHash`, `git.lastSha`, `git.lastCommitMessage`,
 * `git.lastCommitAt`. Esto es ~1 KB total, sin costo Vercel apreciable.
 *
 * Body: { commits: [{ docId, repoPath, contentHash, lastSha, message, commitSha }] }
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { isForgejoConfigured, repoNameForWorkspace, getForgejoOrg } from '@/lib/forgejo';
import { getErrorMessage } from '@/lib/error-utils';

type RouteContext = { params: Promise<{ id: string }> };

interface CommitedEntry {
    docId: string;
    repoPath: string;
    contentHash?: string;
    lastSha?: string;
    size?: number;
    message?: string;
    commitSha?: string;
}

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        if (!isForgejoConfigured()) return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id: workspaceId } = await context.params;
        const body = (await req.json()) as { commits?: unknown };
        const list = Array.isArray(body.commits) ? body.commits as CommitedEntry[] : [];
        if (list.length === 0) return NextResponse.json({ error: 'commits[] required' }, { status: 400 });

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

        const repoFullName = `${getForgejoOrg()}/${repoNameForWorkspace(workspaceId, ownerUid)}`;

        // Persist en batches de Firestore (max 500 ops por batch).
        let persisted = 0;
        for (let i = 0; i < list.length; i += 400) {
            const slice = list.slice(i, i + 400);
            const batch = adminDb.batch();
            for (const c of slice) {
                if (!c.docId) continue;
                const ref = adminDb.collection('documents').doc(c.docId);
                batch.set(ref, {
                    ...(typeof c.contentHash === 'string' ? { contentHash: c.contentHash } : {}),
                    ...(typeof c.size === 'number' ? { size: c.size } : {}),
                    git: {
                        committedHash: c.contentHash ?? null,
                        lastSha: c.lastSha ?? null,
                        repoFullName,
                        lastCommitMessage: c.message ?? null,
                        lastCommitSha: c.commitSha ?? null,
                        lastCommitAt: FieldValue.serverTimestamp()
                    }
                }, { merge: true });
                persisted++;
            }
            await batch.commit();
        }

        return NextResponse.json({ ok: true, persisted });
    } catch (e) {
        console.error('[git/persist-commit] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
