/**
 * POST /api/workspaces/[id]/git/checkout
 * Body: { sha: string; mode: 'detached' | 'newBranch'; branchName?: string }
 *
 * - `newBranch`: crea una rama nueva apuntando al sha (Forgejo API).
 * - `detached`: lectura del árbol al sha (no muta el repo).
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';

import { authorizeGitRoute } from '@/lib/git-route-acl';
import { createBranch } from '@/lib/forgejo-history';
import { listRepoTree } from '@/lib/forgejo-git';
import { getErrorMessage } from '@/lib/error-utils';

export const maxDuration = 60;

const SHA_RE = /^[a-f0-9]{4,40}$/i;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,200}$/;

type RouteContext = { params: Promise<{ id: string }> };

interface RequestBody {
  sha?: unknown;
  mode?: unknown;
  branchName?: unknown;
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { id: workspaceId } = await context.params;
    const acl = await authorizeGitRoute(req, workspaceId);
    if (!acl.ok) return NextResponse.json({ error: acl.error }, { status: acl.status });

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
    }

    const sha = typeof body.sha === 'string' ? body.sha.trim() : '';
    const mode = body.mode;
    if (!SHA_RE.test(sha)) {
      return NextResponse.json({ error: 'sha hex inválido' }, { status: 400 });
    }
    if (mode !== 'detached' && mode !== 'newBranch') {
      return NextResponse.json({ error: 'mode debe ser "detached" o "newBranch"' }, { status: 400 });
    }

    if (mode === 'newBranch') {
      const branchName = typeof body.branchName === 'string' ? body.branchName.trim() : '';
      if (!BRANCH_RE.test(branchName)) {
        return NextResponse.json({ error: 'branchName inválido (formato esperado: A-Z a-z 0-9 _./-, max 200)' }, { status: 400 });
      }
      if (branchName === 'main' || branchName === 'master') {
        return NextResponse.json({ error: 'branchName no puede ser main ni master' }, { status: 400 });
      }
      const r = await createBranch(acl.repoFullName, branchName, sha);
      if (!r.ok) {
        return NextResponse.json({
          ok: false,
          error: r.error ?? `Forgejo respondió ${r.status}`
        }, { status: r.status === 409 ? 409 : 422 });
      }
      return NextResponse.json({
        ok: true,
        branch: branchName,
        sha,
        ...(r.htmlUrl ? { htmlUrl: r.htmlUrl } : {})
      }, { status: 201 });
    }

    // mode === 'detached'
    const tree = await listRepoTree(acl.repoFullName, sha);
    return NextResponse.json({
      ok: true,
      sha,
      treeSize: tree.size,
      files: Array.from(tree.keys()).slice(0, 1000)
    });
  } catch (e) {
    console.error('[git/checkout] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
