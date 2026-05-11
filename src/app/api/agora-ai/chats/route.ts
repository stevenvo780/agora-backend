import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import {
  clampListLimit,
  createAgentChat,
  listAgentChats,
  parseChatCreatePayload
} from '@/lib/agora-ai/chatPersistence';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const url = request.nextUrl;
  const limit = clampListLimit(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor');

  try {
    const { items, nextCursor } = await listAgentChats(auth.uid, { limit, cursor: cursor || null });
    return NextResponse.json({ items, nextCursor });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats] GET', message);
    return NextResponse.json({ error: 'No se pudo listar chats' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  const raw = await request.json().catch(() => null);
  const parsed = parseChatCreatePayload(raw ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const chat = await createAgentChat(auth.uid, parsed.value);
    return NextResponse.json({ chat }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/chats] POST', message);
    return NextResponse.json({ error: 'No se pudo crear chat' }, { status: 500 });
  }
}
