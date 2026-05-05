import { NextRequest } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember, getTokenFromRequest } from '@/lib/server-auth';
import { buildAgoraWorkspaceContext } from '@/lib/agora-ai/context';
import { runProviderConversation } from '@/lib/agora-ai/providerAdapters';
import { claimAgoraAgentRequest } from '@/lib/agora-ai/rateLimit';
import { normalizeAgentAccessPolicy } from '@/lib/agora-ai/accessPolicy';
import { getAgentHooksCached } from '@/lib/agora-ai/agent-hooks-cache';
import type { AgentMode, AgentRequestBody, AgentStreamEvent, AIProvider } from '@/lib/agora-ai/types';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';

export const runtime = 'nodejs';
// Cloud Run admite hasta 3600s (configurado en el servicio). Dejamos 100s
// de margen para poder emitir 'complete' truncado antes del corte duro.
export const maxDuration = 3500;
const SOFT_BUDGET_MS = 3_400_000;

const DEFAULT_MODELS: Record<Exclude<AIProvider, 'ollama'>, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-2.0-flash',
  deepseek: 'deepseek-v4-flash'
};

function encodeEvent(encoder: TextEncoder, payload: AgentStreamEvent) {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth) {
    return new Response('No autorizado', { status: 401 });
  }

  let body: AgentRequestBody;
  try {
    body = await request.json() as AgentRequestBody;
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const {
    messages,
    workspaceId = PERSONAL_WORKSPACE_ID,
    provider,
    apiKey = '',
    model = '',
    mode = 'agent',
    accessPolicy: rawAccessPolicy,
    userInstructions: rawUserInstructions
  } = body;
  const dryRun = (body as unknown as { dryRun?: boolean }).dryRun === true;
  const userInstructions = typeof rawUserInstructions === 'string'
    ? rawUserInstructions.slice(0, 4000)
    : '';

  const effectiveMode: AgentMode = mode === 'chat' ? 'chat' : 'agent';
  const accessPolicy = normalizeAgentAccessPolicy(rawAccessPolicy);

  if (!messages?.length) {
    return new Response('messages is required', { status: 400 });
  }
  if (!provider) {
    return new Response('provider is required', { status: 400 });
  }
  if (provider === 'ollama') {
    return new Response('Ollama se conecta directamente desde el navegador', { status: 400 });
  }
  if (!apiKey) {
    return new Response(`API key requerida para ${provider}`, { status: 400 });
  }

  if (workspaceId && !isPersonalWorkspaceId(workspaceId)) {
    const isMember = await isWorkspaceMember(workspaceId, auth.uid);
    if (!isMember) {
      return new Response('No tienes acceso a este workspace', { status: 403 });
    }
  }

  const claim = claimAgoraAgentRequest(`${auth.uid}:${workspaceId}:${provider}:stream`, {
    minIntervalMs: 900,
    maxConcurrent: 2
  });
  if (!claim.ok) {
    return new Response(`Demasiadas solicitudes seguidas a ${provider}. Intenta de nuevo en ${Math.ceil(claim.retryAfterMs / 1000)}s.`, {
      status: 429,
      headers: {
        'Retry-After': String(Math.ceil(claim.retryAfterMs / 1000))
      }
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (payload: AgentStreamEvent) => {
        if (closed) return;
        controller.enqueue(encodeEvent(encoder, payload));
      };

      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 15000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        claim.release();
        controller.close();
      };

      request.signal.addEventListener('abort', close, { once: true });

      const startedAt = Date.now();
      const softTimeout = setTimeout(() => {
        // Cuando se acerca el cutoff de Vercel emitimos un complete parcial
        // antes de que la función sea matada — así el cliente nunca ve
        // "stream terminó sin respuesta final".
        send({
          type: 'complete',
          reply: 'La respuesta del agente fue truncada por límite de tiempo del servidor (~57 min). Intenta una solicitud más específica o divídela en pasos.',
          agentRun: {
            mode: effectiveMode,
            provider,
            iterations: 0,
            steps: [],
            finalReply: '',
            truncated: true
          }
        });
        close();
      }, SOFT_BUDGET_MS);

      void (async () => {
        try {
          send({ type: 'connected' });
          send({ type: 'status', status: 'Preparando contexto del workspace…' });

          const contextPrompt = workspaceId && accessPolicy.capabilities.workspaceContext
            ? await buildAgoraWorkspaceContext(workspaceId)
            : '';

          const userHooks = await getAgentHooksCached(auth.uid) ?? undefined;
          const agentRun = await runProviderConversation({
            provider,
            apiKey,
            model: model || DEFAULT_MODELS[provider],
            messages: messages.filter(message => message.role !== 'system'),
            contextPrompt,
            mode: effectiveMode,
            executionContext: {
              workspaceId,
              uid: auth.uid,
              email: auth.email,
              origin: request.nextUrl.origin,
              authToken: getTokenFromRequest(request) ?? undefined,
              accessPolicy,
              elapsedBudgetMs: () => Date.now() - startedAt,
              maxBudgetMs: SOFT_BUDGET_MS,
              dryRun,
              hooks: userHooks
            },
            callbacks: {
              onStatus: async (status) => send({ type: 'status', status }),
              onStep: async (step) => send({ type: 'step', step })
            },
            userInstructions
          });

          clearTimeout(softTimeout);
          send({ type: 'complete', reply: agentRun.finalReply, agentRun });
          close();
        } catch (error) {
          clearTimeout(softTimeout);
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('[agora-ai/stream]', message);
          send({ type: 'error', error: message });
          close();
        }
      })();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    }
  });
}
