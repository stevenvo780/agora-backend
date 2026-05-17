/**
 * POST /api/st-libraries/:id/subscribe — registra un workspace como consumer.
 * Requiere que el caller pueda leer la library.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { isLibraryError, subscribeLibrary } from '@/lib/cloud-libraries';

type RouteContext = { params: Promise<{ id: string }> };

const mapLibraryError = (err: unknown): Response => {
  if (isLibraryError(err)) {
    if (err.code === 'not-found') return NextResponse.json({ error: err.message }, { status: 404 });
    if (err.code === 'forbidden') return NextResponse.json({ error: err.message }, { status: 403 });
    if (err.code === 'invalid') return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
};

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id } = await context.params;

    const body = await req.json().catch(() => null) as { workspaceId?: unknown } | null;
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
    if (!workspaceId || workspaceId.length > 128) {
      return NextResponse.json({ error: 'workspaceId inválido' }, { status: 400 });
    }

    if (isPersonalWorkspaceId(workspaceId)) {
      return NextResponse.json({ error: 'workspace personal no puede suscribirse' }, { status: 400 });
    }
    const member = await isWorkspaceMember(workspaceId, auth.uid);
    if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    await subscribeLibrary(id, workspaceId, { uid: auth.uid, workspaceId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('POST /api/st-libraries/[id]/subscribe error', getErrorMessage(error));
    return mapLibraryError(error);
  }
}
