import { NextRequest } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember, getTokenFromRequest } from '@/lib/server-auth';
import { buildAgoraWorkspaceContext } from '@/lib/agora-ai/context';
import { runProviderConversation } from '@/lib/agora-ai/providerAdapters';
import { claimAgoraAgentRequest } from '@/lib/agora-ai/rateLimit';
import { normalizeAgentAccessPolicy } from '@/lib/agora-ai/accessPolicy';
import { getAgentHooksCached } from '@/lib/agora-ai/agent-hooks-cache';
import type { AgentMode, AgentRequestBody, AgentStreamEvent, AIProvider } from '@/lib/agora-ai/types';
import { isPersonalWorkspaceId, PERSONAL_WORKSPACE_ID } from '@/types/workspace';
import {
  appendChatMessage,
  createAgentChat,
  deriveChatTitleFromContent,
  getAgentChat,
  patchAgentChat
} from '@/lib/agora-ai/chatPersistence';
import {
  readDecryptedAgentSecret,
  AGENT_PROVIDER_VALUES,
  type AgentSecretProvider
} from '@/lib/agora-ai/agentSecretsStore';

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
    apiKey: rawApiKey = '',
    model = '',
    mode = 'agent',
    accessPolicy: rawAccessPolicy,
    userInstructions: rawUserInstructions,
    chatId: rawChatId
  } = body;
  const dryRun = (body as unknown as { dryRun?: boolean }).dryRun === true;
  const headerApiKey = request.headers.get('x-agent-key') ?? '';
  let apiKey = (headerApiKey || rawApiKey || '').trim();
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

  // Si el cliente no manda key explícita, intentamos descifrar la guardada
  // server-side para este provider. Nunca persistimos el plaintext.
  if (!apiKey && (AGENT_PROVIDER_VALUES as readonly string[]).includes(provider)) {
    const stored = await readDecryptedAgentSecret(auth.uid, provider as AgentSecretProvider);
    if (stored) apiKey = stored;
  }
  if (!apiKey) {
    return new Response(`No hay key configurada para ${provider}`, { status: 412 });
  }

  if (workspaceId && !isPersonalWorkspaceId(workspaceId)) {
    const isMember = await isWorkspaceMember(workspaceId, auth.uid);
    if (!isMember) {
      return new Response('No tienes acceso a este workspace', { status: 403 });
    }
  }

  // Resolver/crear el chat antes de abrir el stream — el primer evento
  // que ve el cliente cuando es chat nuevo es `chat-created` con el id.
  let activeChatId: string | null = null;
  let isNewChat = false;
  if (typeof rawChatId === 'string' && rawChatId.trim()) {
    const existing = await getAgentChat(auth.uid, rawChatId.trim());
    if (existing) {
      activeChatId = existing.id;
    }
  }
  if (!activeChatId) {
    try {
      const created = await createAgentChat(auth.uid, {
        model: model || undefined,
        provider: provider as AgentSecretProvider
      });
      activeChatId = created.id;
      isNewChat = true;
    } catch (error) {
      console.warn('[agora-ai/stream] no se pudo crear chat persistido:', error instanceof Error ? error.message : error);
    }
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');

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
          },
          ...(activeChatId ? { chatId: activeChatId } : {})
        });
        close();
      }, SOFT_BUDGET_MS);

      void (async () => {
        try {
          send({ type: 'connected' });
          if (activeChatId) {
            send({ type: 'chat-created', chatId: activeChatId });
            if (isNewChat && lastUserMessage?.content?.trim()) {
              patchAgentChat(auth.uid, activeChatId, deriveChatTitleFromContent(lastUserMessage.content)).catch((error) => {
                console.warn('[agora-ai/stream] no se pudo titular chat:', error instanceof Error ? error.message : error);
              });
            }
            if (lastUserMessage?.content?.trim()) {
              appendChatMessage(auth.uid, activeChatId, {
                role: 'user',
                content: lastUserMessage.content
              }).catch((error) => {
                console.warn('[agora-ai/stream] no se pudo persistir mensaje user:', error instanceof Error ? error.message : error);
              });
            }
          }
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
          if (activeChatId && agentRun.finalReply) {
            const toolCalls: unknown[] = [];
            const toolResults: unknown[] = [];
            for (const step of agentRun.steps) {
              if (step.type === 'tool_call' && step.call) toolCalls.push(step.call);
              if (step.type === 'tool_result' && step.result) toolResults.push(step.result);
            }
            const tokens = agentRun.usage?.totalTokens && agentRun.usage.totalTokens > 0
              ? agentRun.usage.totalTokens
              : 0;
            appendChatMessage(auth.uid, activeChatId, {
              role: 'assistant',
              content: agentRun.finalReply,
              ...(toolCalls.length ? { toolCalls } : {}),
              ...(toolResults.length ? { toolResults } : {}),
              ...(tokens ? { tokens } : {})
            }).catch((error) => {
              console.warn('[agora-ai/stream] no se pudo persistir mensaje assistant:', error instanceof Error ? error.message : error);
            });
          }
          send({ type: 'complete', reply: agentRun.finalReply, agentRun, ...(activeChatId ? { chatId: activeChatId } : {}) });
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
