/**
 * POST /api/agora-ai
 *
 * Multi-provider AI chat/agent proxy with Firebase workspace context injection.
 * Supports: OpenAI (ChatGPT), Anthropic (Claude), Google Gemini, DeepSeek.
 * Ollama keeps a direct browser flow because it is commonly deployed locally.
 *
 * API keys: el cliente puede mandar `apiKey` o `X-Agent-Key` (compat con
 * el flujo legacy de localStorage). Si no, leemos la key cifrada del
 * vault server-side y la desciframos en memoria sólo para esta request.
 */
import { NextRequest, NextResponse } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember, getTokenFromRequest } from '@/lib/server-auth';
import { runProviderConversation } from '@/lib/agora-ai/providerAdapters';
import { buildAgoraWorkspaceContext } from '@/lib/agora-ai/context';
import { claimAgoraAgentRequest } from '@/lib/agora-ai/rateLimit';
import { normalizeAgentAccessPolicy } from '@/lib/agora-ai/accessPolicy';
import type { AgentMode, AgentRequestBody, AIProvider } from '@/lib/agora-ai/types';
import { isPersonalWorkspaceId } from '@/types/workspace';
import {
  AGENT_PROVIDER_VALUES,
  readDecryptedAgentSecret,
  type AgentSecretProvider
} from '@/lib/agora-ai/agentSecretsStore';
import { normalizeWorkspaceIdFromBody } from '@/lib/agora-ai/streamRequestValidation';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    // Require authenticated user
    const auth = await requireAuth(request);
    if (!auth) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    const body = await request.json() as AgentRequestBody;
    const {
      messages,
      workspaceId: rawWorkspaceId,
      provider,
      apiKey: rawApiKey = '',
      model = '',
      mode = 'agent',
      accessPolicy: rawAccessPolicy,
      userInstructions: rawUserInstructions
    } = body;
    // F9b: validar workspaceId con regex estricta antes de tocar Firestore.
    const workspaceId = normalizeWorkspaceIdFromBody(rawWorkspaceId);
    if (!workspaceId) {
      return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
    }
    const headerApiKey = request.headers.get('x-agent-key') ?? '';
    let apiKey = (headerApiKey || rawApiKey || '').trim();
    const userInstructions = typeof rawUserInstructions === 'string'
      ? rawUserInstructions.slice(0, 4000)
      : '';
    const effectiveMode: AgentMode = mode === 'chat' ? 'chat' : 'agent';
    const accessPolicy = normalizeAgentAccessPolicy(rawAccessPolicy);

    if (!messages?.length) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 });
    }
    if (!provider) {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 });
    }
    if (provider === 'ollama') {
      return NextResponse.json({ error: 'Ollama se conecta directamente desde el navegador, no a través del servidor' }, { status: 400 });
    }

    // Verify workspace membership when requesting context
    if (workspaceId && !isPersonalWorkspaceId(workspaceId)) {
      const isMember = await isWorkspaceMember(workspaceId, auth.uid);
      if (!isMember) {
        return NextResponse.json({ error: 'No tienes acceso a este workspace' }, { status: 403 });
      }
    }

    const defaults: Record<Exclude<AIProvider, 'ollama'>, string> = {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-haiku-4-5-20251001',
      gemini: 'gemini-2.0-flash',
      deepseek: 'deepseek-v4-flash'
    };

    if (!apiKey && (AGENT_PROVIDER_VALUES as readonly string[]).includes(provider)) {
      const stored = await readDecryptedAgentSecret(auth.uid, provider as AgentSecretProvider);
      if (stored) apiKey = stored;
    }
    if (!apiKey) {
      return NextResponse.json({ error: `No hay key configurada para ${provider}` }, { status: 412 });
    }

    const claim = claimAgoraAgentRequest(`${auth.uid}:${workspaceId}:${provider}`, {
      minIntervalMs: 900,
      maxConcurrent: 2
    });
    if (!claim.ok) {
      return NextResponse.json({
        error: `Demasiadas solicitudes seguidas a ${provider}. Intenta de nuevo en ${Math.ceil(claim.retryAfterMs / 1000)}s.`,
        retryAfterMs: claim.retryAfterMs,
        reason: claim.reason
      }, { status: 429 });
    }

    try {
      const contextPrompt = workspaceId && accessPolicy.capabilities.workspaceContext
        ? await buildAgoraWorkspaceContext(workspaceId)
        : '';
      const agentRun = await runProviderConversation({
        provider,
        apiKey,
        model: model || defaults[provider],
        messages: messages.filter(message => message.role !== 'system'),
        contextPrompt,
        mode: effectiveMode,
        executionContext: {
          workspaceId,
          uid: auth.uid,
          email: auth.email,
          origin: request.nextUrl.origin,
          authToken: getTokenFromRequest(request) ?? undefined,
          accessPolicy
        },
        userInstructions
      });

      return NextResponse.json({ reply: agentRun.finalReply, agentRun });
    } finally {
      claim.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
