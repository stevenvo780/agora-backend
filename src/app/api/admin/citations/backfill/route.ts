import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember, isAdminUser } from '@/lib/server-auth';
import { backfillWorkspaceCitations } from '@/lib/citations/workspace-citations';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { getErrorMessage } from '@/lib/error-utils';

interface BackfillBody {
  workspaceId: string;
  force?: boolean;
}

const parseBody = (raw: unknown): BackfillBody | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.workspaceId !== 'string' || obj.workspaceId.trim().length === 0) return null;
  const force = obj.force === true;
  return { workspaceId: obj.workspaceId.trim(), force };
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: 'Body inválido' }, { status: 400 });
    }
    const parsed = parseBody(rawBody);
    if (!parsed) {
      return NextResponse.json({ error: 'workspaceId requerido' }, { status: 400 });
    }

    const { workspaceId } = parsed;
    if (!isPersonalWorkspaceId(workspaceId)) {
      const member = await isWorkspaceMember(workspaceId, auth.uid);
      if (!member) {
        const admin = await isAdminUser(auth.uid).catch(() => false);
        if (!admin) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      }
    }

    const result = await backfillWorkspaceCitations(workspaceId, auth.uid);
    return NextResponse.json({
      workspaceId,
      docsProcessed: result.docsProcessed,
      edgesWritten: result.edgesWritten,
      conceptEdges: result.conceptEdges,
      durationMs: result.durationMs,
      errors: result.errors
    });
  } catch (error) {
    console.error('POST /api/admin/citations/backfill error', getErrorMessage(error));
    return NextResponse.json({ error: 'Internal error', detail: getErrorMessage(error) }, { status: 500 });
  }
}
