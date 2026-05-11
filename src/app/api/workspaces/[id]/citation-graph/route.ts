import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';
import { expandSubgraph } from '@/lib/citations/graph-store';
import { isCitationKind, type CitationKind } from '@/lib/citations/types';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';

const parseDepth = (raw: string | null): number => {
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, Math.floor(n)));
};

const parseKinds = (raw: string | null): CitationKind[] | undefined => {
  if (!raw) return undefined;
  const parts = raw.split(',').map((v) => v.trim()).filter(Boolean);
  const out: CitationKind[] = [];
  for (const part of parts) {
    if (isCitationKind(part)) out.push(part);
  }
  return out.length > 0 ? out : undefined;
};

const parseFocus = (raw: string | null): string[] => {
  if (!raw) return [];
  return raw.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
};

export async function GET(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }
    const params = await ctx.params;
    const workspaceId = params.id;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId requerido' }, { status: 400 });
    }
    if (!isPersonalWorkspaceId(workspaceId)) {
      const member = await isWorkspaceMember(workspaceId, auth.uid);
      if (!member) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const url = req.nextUrl;
    const focus = parseFocus(url.searchParams.get('focus'));
    if (focus.length === 0) {
      return NextResponse.json({ error: 'focus es requerido (csv de docIds)' }, { status: 400 });
    }
    const depth = parseDepth(url.searchParams.get('depth'));
    const kinds = parseKinds(url.searchParams.get('kinds'));

    const subgraph = await expandSubgraph({
      workspaceId,
      uid: auth.uid,
      focusDocIds: focus,
      depth,
      ...(kinds ? { kinds } : {})
    });
    return NextResponse.json(subgraph);
  } catch (error) {
    console.error('GET /api/workspaces/[id]/citation-graph error', getErrorMessage(error));
    return NextResponse.json({ error: 'Internal error', detail: getErrorMessage(error) }, { status: 500 });
  }
}
