import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import {
  AGENT_PROVIDER_VALUES,
  deleteAgentSecret,
  type AgentSecretProvider
} from '@/lib/agora-ai/agentSecretsStore';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ provider: string }> };

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const { provider } = await context.params;

  if (!(AGENT_PROVIDER_VALUES as readonly string[]).includes(provider)) {
    return NextResponse.json({ error: `provider inválido: ${provider}` }, { status: 400 });
  }

  try {
    const removed = await deleteAgentSecret(auth.uid, provider as AgentSecretProvider);
    if (!removed) return NextResponse.json({ error: 'Key no encontrada' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/keys/:provider] DELETE', message);
    return NextResponse.json({ error: 'No se pudo eliminar key' }, { status: 500 });
  }
}
