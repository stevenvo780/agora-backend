/**
 * GET /api/workspaces/[id]/git/graph?limit=N
 * Devuelve commits enriquecidos con `parents` + `refs` (branches/tags) para
 * que el cliente dibuje un gitgraph.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';

import { authorizeGitRoute } from '@/lib/git-route-acl';
import {
  listCommitsWithParents,
  listBranches,
  listTags,
  getRepoMeta
} from '@/lib/forgejo-history';
import { getErrorMessage } from '@/lib/error-utils';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id: workspaceId } = await context.params;
    const acl = await authorizeGitRoute(req, workspaceId);
    if (!acl.ok) return NextResponse.json({ error: acl.error }, { status: acl.status });

    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10)), 200);

    const [commits, branches, tags, meta] = await Promise.all([
      listCommitsWithParents(acl.repoFullName, limit),
      listBranches(acl.repoFullName),
      listTags(acl.repoFullName),
      getRepoMeta(acl.repoFullName)
    ]);

    const refsBySha = new Map<string, string[]>();
    for (const b of branches) {
      const sha = b?.commit?.id;
      if (typeof sha !== 'string') continue;
      const arr = refsBySha.get(sha) ?? [];
      arr.push(b.name);
      refsBySha.set(sha, arr);
    }
    for (const t of tags) {
      const sha = t?.commit?.sha ?? t?.id;
      if (typeof sha !== 'string') continue;
      const arr = refsBySha.get(sha) ?? [];
      arr.push(`tag:${t.name}`);
      refsBySha.set(sha, arr);
    }

    return NextResponse.json({
      repoFullName: acl.repoFullName,
      defaultBranch: meta?.defaultBranch ?? 'main',
      commits: commits.map((c) => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 8),
        parents: (c.parents ?? []).map((p) => p.sha).filter((s): s is string => typeof s === 'string'),
        message: c.commit?.message ?? '',
        authorName: c.commit?.author?.name ?? '',
        authorEmail: c.commit?.author?.email ?? '',
        date: c.commit?.author?.date ?? '',
        htmlUrl: c.html_url ?? '',
        refs: refsBySha.get(c.sha) ?? []
      }))
    });
  } catch (e) {
    console.error('[git/graph] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
