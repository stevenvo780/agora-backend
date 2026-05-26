import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import {
  appendChatMessage,
  clampMessagesLimit,
  getAgentChat,
  listChatMessages,
  parseChatMessageAppendPayload,
  truncateChatFromUserIndex,
  truncateChatMessagesFrom
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

// Trunca la conversación para el checkpoint "volver aquí". Acepta
// `?fromUserIndex=<n>` (preferido: posición del N-ésimo turno user) o
// `?from=<msgId>` (doc id). Borra ese punto y todo lo posterior.
export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { id } = await context.params;

  const params = request.nextUrl.searchParams;
  const fromUserIndexRaw = params.get('fromUserIndex');
  const from = params.get('from');
  if (fromUserIndexRaw === null && !from) {
    return NextResponse.json({ error: 'Falta "fromUserIndex" o "from"' }, { status: 400 });
  }

  try {
    const chat = await getAgentChat(auth.uid, id);
    if (!chat) return NextResponse.json({ error: 'Chat no encontrado' }, { status: 404 });
    let deleted: number | null;
    if (fromUserIndexRaw !== null) {
      const idx = Number.parseInt(fromUserIndexRaw, 10);
      deleted = await truncateChatFromUserIndex(auth.uid, id, idx);
    } else {
      deleted = await truncateChatMessagesFrom(auth.uid, id, from as string);
    }
    if (deleted === null) return NextResponse.json({ error: 'Punto de truncado no encontrado' }, { status: 404 });
    return NextResponse.json({ deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats/:id/messages] DELETE', message);
    return NextResponse.json({ error: 'No se pudo truncar la conversación' }, { status: 500 });
  }
}
