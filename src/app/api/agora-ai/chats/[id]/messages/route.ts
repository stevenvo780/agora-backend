import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import {
  appendChatMessage,
  clampMessagesLimit,
  getAgentChat,
  listChatMessages,
  parseChatMessageAppendPayload
} from '@/lib/agora-ai/chatPersistence';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { id } = await context.params;

  const url = request.nextUrl;
  const limit = clampMessagesLimit(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor');

  try {
    const chat = await getAgentChat(auth.uid, id);
    if (!chat) return NextResponse.json({ error: 'Chat no encontrado' }, { status: 404 });
    const { items, nextCursor } = await listChatMessages(auth.uid, id, { limit, cursor: cursor || null });
    return NextResponse.json({ items, nextCursor });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats/:id/messages] GET', message);
    return NextResponse.json({ error: 'No se pudo listar mensajes' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { id } = await context.params;

  const raw = await request.json().catch(() => null);
  const parsed = parseChatMessageAppendPayload(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const chat = await getAgentChat(auth.uid, id);
    if (!chat) return NextResponse.json({ error: 'Chat no encontrado' }, { status: 404 });
    const message = await appendChatMessage(auth.uid, id, parsed.value);
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats/:id/messages] POST', message);
    return NextResponse.json({ error: 'No se pudo agregar mensaje' }, { status: 500 });
  }
}
