import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth } from '@/lib/server-auth';
import { isAgentVaultConfigured } from '@/lib/agora-ai/agentVault';
import {
  listAgentSecrets,
  parseAgentKeySavePayload,
  saveAgentSecret
} from '@/lib/agora-ai/agentSecretsStore';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  try {
    const items = await listAgentSecrets(auth.uid);
    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/keys] GET', message);
    return NextResponse.json({ error: 'No se pudo listar keys' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });

  if (!isAgentVaultConfigured()) {
    return NextResponse.json({ error: 'WORKER_SECRET no configurado' }, { status: 503 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = parseAgentKeySavePayload(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const summary = await saveAgentSecret(auth.uid, parsed.value.provider, parsed.value.key);
    // Nunca devolver la key — solo provider + hint.
    return NextResponse.json({ secret: summary }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[agora-ai/keys] POST', message);
    return NextResponse.json({ error: 'No se pudo guardar key' }, { status: 500 });
  }
}
