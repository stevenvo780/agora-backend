import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember } from '@/lib/server-auth';
import { executeAgentTool } from '@/lib/agora-ai/toolExecutor';
import { normalizeAgentAccessPolicy } from '@/lib/agora-ai/accessPolicy';
import type { AgentExecutionContext, AgentToolCall } from '@/lib/agora-ai/types';
import { isPersonalWorkspaceId } from '@/types/workspace';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Endpoint interno para ejecutar tools del agente dentro de AgoraBack.
 *
 * Auth: JWT del user (Bearer) + un secreto interno compartido para evitar que
 * clientes ajenos llamen este endpoint directamente.
 */

const INTERNAL_SECRET = (process.env.BACKEND_INTERNAL_SECRET || process.env.HUB_INTERNAL_SECRET || '').trim();

interface ExecuteToolBody {
  call?: AgentToolCall;
  ctx?: Partial<AgentExecutionContext>;
}

export async function POST(request: NextRequest) {
  if (!INTERNAL_SECRET) {
    return NextResponse.json({ ok: false, error: 'BACKEND_INTERNAL_SECRET no configurado' }, { status: 500 });
  }
  const provided = request.headers.get('x-backend-internal-secret') || request.headers.get('x-hub-internal-secret') || '';
  if (provided !== INTERNAL_SECRET) {
    return NextResponse.json({ ok: false, error: 'invalid_internal_secret' }, { status: 403 });
  }

  const auth = await requireAuth(request);
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: ExecuteToolBody;
  try {
    body = await request.json() as ExecuteToolBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const call = body.call;
  if (!call?.name || !call?.id) {
    return NextResponse.json({ ok: false, error: 'call.name y call.id son requeridos' }, { status: 400 });
  }

  const incoming = body.ctx ?? {};
  const workspaceId = String(incoming.workspaceId || 'personal');

  if (workspaceId && !isPersonalWorkspaceId(workspaceId)) {
    const isMember = await isWorkspaceMember(workspaceId, auth.uid);
    if (!isMember) {
      return NextResponse.json({ ok: false, error: 'forbidden_workspace' }, { status: 403 });
    }
  }

  const ctx: AgentExecutionContext = {
    workspaceId,
    uid: auth.uid,
    email: auth.email ?? null,
    origin: incoming.origin ?? request.nextUrl.origin,
    llmEndpoint: incoming.llmEndpoint,
    llmModel: incoming.llmModel,
    authToken: request.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
    accessPolicy: normalizeAgentAccessPolicy(incoming.accessPolicy)
  };

  try {
    const result = await executeAgentTool(call, ctx);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    console.error('[internal/execute-tool]', call.name, message);
    return NextResponse.json({
      ok: false,
      name: call.name,
      callId: call.id,
      summary: `Error ejecutando ${call.name}: ${message}`,
      error: message
    });
  }
}
