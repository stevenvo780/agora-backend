/**
 * GET /api/workspaces/[id]/git/diff?base=<sha>&head=<sha>
 * Devuelve el diff unificado entre dos commits del repo del workspace.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';

export const runtime = 'nodejs';

import { authorizeGitRoute } from '@/lib/git-route-acl';
import { compareRefs } from '@/lib/forgejo-history';
import { getErrorMessage } from '@/lib/error-utils';

export const maxDuration = 60;

const SHA_RE = /^[a-f0-9]{4,40}$/i;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { id: workspaceId } = await context.params;
    const acl = await authorizeGitRoute(req, workspaceId);
    if (!acl.ok) return NextResponse.json({ error: acl.error }, { status: acl.status });

    const { searchParams } = new URL(req.url);
    const base = (searchParams.get('base') ?? '').trim();
    const head = (searchParams.get('head') ?? '').trim();

    if (!SHA_RE.test(base) || !SHA_RE.test(head)) {
      return NextResponse.json({ error: 'base y head deben ser shas hex válidos' }, { status: 400 });
    }

    const diff = await compareRefs(acl.repoFullName, base, head);
    if (!diff) {
      return NextResponse.json({ error: 'No se pudo obtener el diff (¿shas inválidos?)' }, { status: 404 });
    }

    return NextResponse.json({
      base,
      head,
      files: diff.files,
      stats: diff.stats,
      truncated: diff.truncated
    });
  } catch (e) {
    console.error('[git/diff] error:', getErrorMessage(e));
    return NextResponse.json({ error: getErrorMessage(e) }, { status: 500 });
  }
}
