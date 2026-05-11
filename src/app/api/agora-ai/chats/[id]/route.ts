import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import {
  deleteAgentChat,
  getAgentChat,
  parseChatPatchPayload,
  patchAgentChat
} from '@/lib/agora-ai/chatPersistence';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { id } = await context.params;

  try {
    const chat = await getAgentChat(auth.uid, id);
    if (!chat) return NextResponse.json({ error: 'Chat no encontrado' }, { status: 404 });
    return NextResponse.json({ chat });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats/:id] GET', message);
    return NextResponse.json({ error: 'No se pudo leer chat' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { id } = await context.params;

  const raw = await request.json().catch(() => null);
  const parsed = parseChatPatchPayload(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const updated = await patchAgentChat(auth.uid, id, parsed.value.title);
    if (!updated) return NextResponse.json({ error: 'Chat no encontrado' }, { status: 404 });
    const chat = await getAgentChat(auth.uid, id);
    return NextResponse.json({ chat });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats/:id] PATCH', message);
    return NextResponse.json({ error: 'No se pudo actualizar chat' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { id } = await context.params;

  try {
    const removed = await deleteAgentChat(auth.uid, id);
    if (!removed) return NextResponse.json({ error: 'Chat no encontrado' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats/:id] DELETE', message);
    return NextResponse.json({ error: 'No se pudo eliminar chat' }, { status: 500 });
  }
}
