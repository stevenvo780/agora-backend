import { adminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { isWorkspaceMember, requireAuth } from '@/lib/server-auth';
import { isPersonalWorkspaceId } from '@/types/workspace';
import { parseSnippetUpdatePayload } from '@agora/contracts';

const canAccessSnippet = async (snippet: Record<string, unknown> | undefined, uid: string) => {
  const workspaceId = typeof snippet?.workspaceId === 'string' ? snippet.workspaceId : null;
  if (isPersonalWorkspaceId(workspaceId)) {
    return snippet?.ownerId === uid;
  }
  if (!workspaceId) return false;
  return isWorkspaceMember(workspaceId, uid);
};

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { id } = await context.params;
    const rawBody = await req.json().catch(() => null);
    const parsed = parseSnippetUpdatePayload(rawBody);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const body = parsed.value;

    const ref = adminDb.collection('snippets').doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Snippet not found' }, { status: 404 });
    }
    if (!(await canAccessSnippet(snap.data() as Record<string, unknown> | undefined, auth.uid))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp(), ...body };

    await ref.update(updates);
    return NextResponse.json({ id, ...updates });
  } catch (err) {
    console.error('PUT /api/snippets/[id] error', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const auth = await requireAuth(req);
    if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

    const { id } = await context.params;
    const ref = adminDb.collection('snippets').doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Snippet not found' }, { status: 404 });
    }
    if (!(await canAccessSnippet(snap.data() as Record<string, unknown> | undefined, auth.uid))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/snippets/[id] error', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
