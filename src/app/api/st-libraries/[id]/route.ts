/**
 * /api/st-libraries/:id — GET (auth + visibility), PATCH (owner), DELETE (owner).
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { getErrorMessage } from '@/lib/error-utils';
import { requireAuth } from '@/lib/server-auth';
import {
  deleteLibrary,
  getLibrary,
  isLibraryError,
  parseLibraryUpdatePatch,
  updateLibrary
} from '@/lib/cloud-libraries';

type RouteContext = { params: Promise<{ id: string }> };

const mapLibraryError = (err: unknown): Response => {
  if (isLibraryError(err)) {
    if (err.code === 'not-found') return NextResponse.json({ error: err.message }, { status: 404 });
    if (err.code === 'forbidden') return NextResponse.json({ error: err.message }, { status: 403 });
    if (err.code === 'invalid') return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
};

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id } = await context.params;

    const requesterWorkspaceId = req.nextUrl.searchParams.get('workspaceId') || undefined;
    const library = await getLibrary(id, { uid: auth.uid, workspaceId: requesterWorkspaceId });
    if (!library) return NextResponse.json({ error: 'Library not found' }, { status: 404 });
    return NextResponse.json(library);
  } catch (error) {
    console.error('GET /api/st-libraries/[id] error', getErrorMessage(error));
    return mapLibraryError(error);
  }
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id } = await context.params;

    const body = await req.json().catch(() => null);
    const parsed = parseLibraryUpdatePatch(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const updated = await updateLibrary(id, parsed.value, { uid: auth.uid });
    return NextResponse.json(updated);
  } catch (error) {
    console.error('PATCH /api/st-libraries/[id] error', getErrorMessage(error));
    return mapLibraryError(error);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    const { id } = await context.params;

    const removed = await deleteLibrary(id, { uid: auth.uid });
    if (!removed) return NextResponse.json({ error: 'Library not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DELETE /api/st-libraries/[id] error', getErrorMessage(error));
    return mapLibraryError(error);
  }
}
