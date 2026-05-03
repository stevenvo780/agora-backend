/**
 * GET /api/workspaces/[id]/git/log?limit=30
 * Devuelve historial de commits del repo del workspace.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';

export const runtime = 'nodejs';
import { adminDb } from '@/lib/firebase-admin';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { isForgejoConfigured, repoNameForWorkspace, getForgejoOrg } from '@/lib/forgejo';
import { listCommits } from '@/lib/forgejo-git';
import { getErrorMessage } from '@/lib/error-utils';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
    try {
        if (!isForgejoConfigured()) return NextResponse.json({ error: 'Forgejo not configured' }, { status: 503 });
        const auth = await requireAuth(req);
        if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

        const { id: workspaceId } = await context.params;
        const { searchParams } = new URL(req.url);
        const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') ?? '30', 10)), 100);

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

        const commits = await listCommits(repoFullName, limit);
        return NextResponse.json({
            repoFullName,
            commits: commits.map((c) => ({
                sha: c.sha,
                shortSha: c.sha.slice(0, 8),
                message: c.commit.message,
                authorName: c.commit.author.name,
                authorEmail: c.commit.author.email,
                date: c.commit.author.date,
                htmlUrl: c.html_url
            }))
        });
    } catch (e) {
        console.error('[git/log] error:', getErrorMessage(e));
        return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
    }
}
