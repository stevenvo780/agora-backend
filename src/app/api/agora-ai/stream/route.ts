import { randomUUID } from 'node:crypto';
import { NextRequest } from '@/lib/http/next-server';
import { requireAuth, isWorkspaceMember, getTokenFromRequest } from '@/lib/server-auth';
import { buildAgoraWorkspaceContext } from '@/lib/agora-ai/context';
import { runProviderConversation } from '@/lib/agora-ai/providerAdapters';
import { claimAgoraAgentRequest, formatRetryAfter } from '@/lib/agora-ai/rateLimit';
import {
  checkDailyBudget,
  checkHourlyMessageCap,
  checkAbuseBlock,
  incrementMessageCount,
  recordAbuseSignal,
  recordUsage,
  logAbuseSignal
} from '@/lib/agora-ai/usageTracking';
import { normalizeAgentAccessPolicy } from '@/lib/agora-ai/accessPolicy';
import { getAgentHooksCached } from '@/lib/agora-ai/agent-hooks-cache';
import { getAgentSettings, resolveAgentSettings } from '@/lib/agora-ai/agentSettingsStore';
import type { AgentMode, AgentRequestBody, AgentStreamEvent, AIProvider } from '@/lib/agora-ai/types';
import { isPersonalWorkspaceId } from '@/types/workspace';
import {
  appendChatMessage,
  upsertStreamingAssistantMessage,
  createAgentChat,
  deriveChatTitleFromContent,
  getAgentChat,
  patchAgentChat,
  ChatLimitExceededError
} from '@/lib/agora-ai/chatPersistence';
import {
  readDecryptedAgentSecret,
  AGENT_PROVIDER_VALUES,
  type AgentSecretProvider
} from '@/lib/agora-ai/agentSecretsStore';
import {
  checkMessagesSize,
  sanitizeIncomingMessages,
  normalizeWorkspaceIdFromBody,
  MAX_MESSAGES_BYTES
} from '@/lib/agora-ai/streamRequestValidation';

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
    messages: rawMessages,
    workspaceId: rawWorkspaceId,
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

  // F9b: validar workspaceId con regex estricta (rechaza `../admin`, path
  // traversal, control chars). Hacelo ANTES de tocar Firestore.
  const workspaceId = normalizeWorkspaceIdFromBody(rawWorkspaceId);
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'invalid_workspace_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return new Response('messages is required', { status: 400 });
  }
  if (!provider) {
    return new Response('provider is required', { status: 400 });
  }
  if (provider === 'ollama') {
    return new Response('Ollama se conecta directamente desde el navegador', { status: 400 });
  }

  // F7: cap del tamaño total del array de messages. 256KB ≈ 64K tokens en
  // el caso pesimista. Cualquier payload mayor es DoS / cost-amplification.
  const sizeCheck = checkMessagesSize(rawMessages);
  if (!sizeCheck.ok) {
    return new Response(JSON.stringify({
      error: 'messages_too_large',
      limit: sizeCheck.limit,
      actual: sizeCheck.totalBytes
    }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // F1 + F11b: sanitizar el array de messages. Rechazamos `role:tool` del
  // cliente (HARD 400) y marcamos `role:assistant` como historial no
  // autoritativo para que el modelo no lo cite como output real.
  const sanitized = sanitizeIncomingMessages(rawMessages);
  if (!sanitized.ok) {
    console.warn('[agora-ai/stream] messages rejected:', sanitized.rejected?.reason);
    return new Response(JSON.stringify({
      error: 'invalid_messages',
      reason: sanitized.rejected?.reason ?? 'unknown'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const messages = sanitized.messages;
  if (!messages.length) {
    // Edge case: cliente mandó solo `role:system`/`role:tool` o nada
    // utilizable tras sanitización.
    return new Response('messages is required (after sanitization)', { status: 400 });
  }
  if (sanitized.warnings.length) {
    console.warn('[agora-ai/stream] sanitize warnings:', sanitized.warnings.slice(0, 5).join(' | '));
  }
  // Silenciar el warning de la variable usada en runtime — el cap está
  // expuesto vía export para tests/clientes.
  void MAX_MESSAGES_BYTES;

  // C5a: validar que el último mensaje de usuario tenga contenido no vacío
  // ANTES de crear cualquier documento en Firestore. Un mensaje vacío no tiene
  // sentido semántico y era la causa de chats fantasma con title "Nuevo chat"
  // y cero mensajes persistidos.
  const lastUserMessageForValidation = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessageForValidation || !lastUserMessageForValidation.content?.trim()) {
    return new Response(JSON.stringify({ error: 'El mensaje del usuario no puede estar vacío' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
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
      // C5b: si el usuario alcanzó el cap de chats, rechazar con 429 antes
      // de abrir el stream. Para otros errores de Firestore, degradar
      // graciosamente (stream sin persistencia).
      if (error instanceof ChatLimitExceededError) {
        return new Response(JSON.stringify({ error: error.message, reason: 'chat-limit-exceeded', limit: error.limit }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      console.warn('[agora-ai/stream] no se pudo crear chat persistido:', error instanceof Error ? error.message : error);
    }
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');

  // --- Abuse prevention / rate limiting fino ---------------------------------
  // Orden: abuse-block (cooldown duro) → hourly cap (spam) → daily budget
  // (cost). Cada 429 acumula señal; 5×429 en 10min → blocklist 10min.

  const reply429 = (
    body: string,
    retryAfterSec: number,
    reason: 'abuse-block' | 'hourly-message-cap' | 'daily-token-budget',
    retryAfterMs: number,
    extra: Record<string, unknown> = {}
  ): Response => {
    recordAbuseSignal(auth.uid);
    logAbuseSignal({
      uid: auth.uid,
      workspaceId,
      model: model || 'unknown',
      toolCallCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
      status: reason === 'daily-token-budget'
        ? 'budget-exceeded'
        : reason === 'abuse-block' ? 'blocked' : 'rate-limited'
    });
    // El front lee `retryAfter` como SEGUNDOS (igual que el header Retry-After).
    // Mandar ms acá hacía que mostrara ~195949 min (×1000). retryAfterMs queda
    // como campo aparte por si algún consumidor lo necesita en ms.
    return new Response(JSON.stringify({ error: body, reason, retryAfter: retryAfterSec, retryAfterMs, ...extra }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(1, retryAfterSec))
      }
    });
  };

  const abuse = checkAbuseBlock(auth.uid);
  if (!abuse.ok) {
    return reply429(
      `Usuario bloqueado temporalmente por exceso de rate-limits. Intenta de nuevo en ${formatRetryAfter(abuse.retryAfterMs)}.`,
      Math.ceil(abuse.retryAfterMs / 1000),
      'abuse-block',
      abuse.retryAfterMs
    );
  }

  const hourly = checkHourlyMessageCap(auth.uid);
  if (!hourly.ok) {
    return reply429(
      `Has superado el límite horario de mensajes al agente (${hourly.cap}/h). Intenta de nuevo en ${formatRetryAfter(hourly.retryAfterMs)}.`,
      Math.ceil(hourly.retryAfterMs / 1000),
      'hourly-message-cap',
      hourly.retryAfterMs,
      { used: hourly.used, cap: hourly.cap }
    );
  }

  const daily = await checkDailyBudget(auth.uid, provider);
  if (!daily.ok) {
    return reply429(
      'Daily token budget exceeded',
      Math.ceil(daily.retryAfterMs / 1000),
      'daily-token-budget',
      daily.retryAfterMs,
      { used: daily.used, budget: daily.budget, provider: daily.provider }
    );
  }

  incrementMessageCount(auth.uid);

  const claim = claimAgoraAgentRequest(`${auth.uid}:${workspaceId}:${provider}:stream`, {
    minIntervalMs: 900,
    maxConcurrent: 2
  });
  if (!claim.ok) {
    return reply429(
      `Demasiadas solicitudes seguidas a ${provider}. Intenta de nuevo en ${formatRetryAfter(claim.retryAfterMs)}.`,
      Math.ceil(claim.retryAfterMs / 1000),
      'abuse-block',
      claim.retryAfterMs
    );
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

      // --- Estado del mensaje assistant persistido incrementalmente ----------
      // El doc se crea con status:"running" tras persistir el user; se actualiza
      // throttleado durante el run (steps como progreso) y se finaliza con el
      // reply completo + status terminal. Una sola fila por turno (mismo msgId).
      let assistantMsgId: string | null = null;
      let assistantTs = 0;
      const liveToolCalls: unknown[] = [];
      const liveToolResults: unknown[] = [];
      let lastUpsertAt = 0;
      let upsertPending = false;
      let upsertInFlight = false;
      let inFlightUpsert: Promise<void> = Promise.resolve();
      const UPSERT_THROTTLE_MS = 1500;
      let assistantFinalized = false;

      // Flush throttleado del progreso parcial. No escribe en cada step: como
      // mucho 1 vez cada UPSERT_THROTTLE_MS; si llega un step dentro de la
      // ventana, deja `upsertPending` y se escribe en el próximo intento.
      const flushRunningUpsert = (force = false): void => {
        if (!assistantMsgId || !activeChatId || assistantFinalized) return;
        const now = Date.now();
        if (!force && (upsertInFlight || now - lastUpsertAt < UPSERT_THROTTLE_MS)) {
          upsertPending = true;
          return;
        }
        upsertPending = false;
        lastUpsertAt = now;
        upsertInFlight = true;
        inFlightUpsert = upsertStreamingAssistantMessage(auth.uid, activeChatId, assistantMsgId, assistantTs, {
          content: '',
          status: 'running',
          ...(liveToolCalls.length ? { toolCalls: [...liveToolCalls] } : {}),
          ...(liveToolResults.length ? { toolResults: [...liveToolResults] } : {})
        }).catch((error) => {
          console.warn('[agora-ai/stream] upsert running assistant falló:', error instanceof Error ? error.message : error);
        }).finally(() => {
          upsertInFlight = false;
          if (upsertPending && !assistantFinalized) flushRunningUpsert();
        });
      };

      // Finaliza el doc assistant con un status terminal y el contenido que haya
      // (parcial en error/truncado). Idempotente: solo finaliza una vez.
      const finalizeAssistantDoc = async (
        status: 'complete' | 'truncated' | 'error',
        content: string,
        tokens: number
      ): Promise<void> => {
        if (!assistantMsgId || !activeChatId || assistantFinalized) return;
        // Marcar finalizado ANTES de esperar el upsert en vuelo: esto impide que
        // su `.finally` dispare un nuevo flush `running`. Luego esperamos a que
        // el upsert en vuelo termine de escribir, así su `status:"running"` no
        // puede aterrizar DESPUÉS del status terminal y dejar el doc atascado.
        assistantFinalized = true;
        try {
          await inFlightUpsert;
        } catch {
          // el error del upsert en vuelo ya se logueó en su propio .catch
        }
        try {
          await upsertStreamingAssistantMessage(auth.uid, activeChatId, assistantMsgId, assistantTs, {
            content,
            status,
            ...(liveToolCalls.length ? { toolCalls: [...liveToolCalls] } : {}),
            ...(liveToolResults.length ? { toolResults: [...liveToolResults] } : {}),
            ...(tokens > 0 ? { tokens } : {})
          });
        } catch (error) {
          console.warn('[agora-ai/stream] finalizar assistant falló:', error instanceof Error ? error.message : error);
        }
      };

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
        logAbuseSignal({
          uid: auth.uid,
          workspaceId,
          model: model || 'unknown',
          toolCallCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          durationMs: Date.now() - startedAt,
          status: 'truncated'
        });
        // Si el doc assistant ya existe, finalizarlo como truncado con el
        // progreso parcial antes de cerrar — un reload muestra el estado real.
        void finalizeAssistantDoc('truncated', '', 0).finally(close);
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
            // Crear ya el doc assistant en status:"running" con un id estable.
            // `assistantTs` se captura UNA vez y se reusa en todos los upserts
            // para que el orden por `ts` no cambie. Lo emitimos al cliente para
            // que pueda reconciliar al recargar (poll por messageId).
            assistantMsgId = randomUUID();
            assistantTs = Date.now();
            void upsertStreamingAssistantMessage(auth.uid, activeChatId, assistantMsgId, assistantTs, {
              content: '',
              status: 'running'
            }).catch((error) => {
              console.warn('[agora-ai/stream] no se pudo crear doc assistant inicial:', error instanceof Error ? error.message : error);
            });
            send({ type: 'assistant-message', messageId: assistantMsgId, chatId: activeChatId });
          }
          send({ type: 'status', status: 'Preparando contexto del workspace…' });

          const contextPrompt = workspaceId && accessPolicy.capabilities.workspaceContext
            ? await buildAgoraWorkspaceContext(workspaceId)
            : '';

          const userHooks = await getAgentHooksCached(auth.uid) ?? undefined;
          // Settings de autonomía (Firestore, validados con schema). mainModel
          // override del default; auxModel barato para clasificar confirmaciones;
          // autonomousMode habilita el bypass de "¿continúo?".
          const requestModel = model || DEFAULT_MODELS[provider];
          const settings = resolveAgentSettings(
            await getAgentSettings(auth.uid),
            provider,
            requestModel
          );
          const agentRun = await runProviderConversation({
            provider,
            apiKey,
            model: settings.mainModel,
            // `messages` ya fue sanitizado (no contiene role:system ni role:tool).
            messages,
            contextPrompt,
            mode: effectiveMode,
            autonomousMode: settings.autonomousMode,
            auxModel: settings.auxModel,
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
              onStep: async (step) => {
                send({ type: 'step', step });
                // Acumular el progreso en los mismos buckets que usa el upsert
                // final (tool_call → toolCalls, tool_result/error → toolResults)
                // y persistirlo throttleado como status:"running".
                if (step.type === 'tool_call' && step.call) liveToolCalls.push(step.call);
                if ((step.type === 'tool_result' || step.type === 'error') && step.result) liveToolResults.push(step.result);
                flushRunningUpsert();
              },
              onContextTruncated: async (removedCount, summary) =>
                send({ type: 'context-truncated', removedCount, summary })
            },
            userInstructions
          });

          clearTimeout(softTimeout);
          if (activeChatId && assistantMsgId) {
            // Set autoritativo de tool calls/results del run completo, por si el
            // throttle se saltó el último step. Reemplaza los buckets vivos.
            liveToolCalls.length = 0;
            liveToolResults.length = 0;
            for (const step of agentRun.steps) {
              if (step.type === 'tool_call' && step.call) liveToolCalls.push(step.call);
              if ((step.type === 'tool_result' || step.type === 'error') && step.result) liveToolResults.push(step.result);
            }
            const tokens = agentRun.usage?.totalTokens && agentRun.usage.totalTokens > 0
              ? agentRun.usage.totalTokens
              : 0;
            await finalizeAssistantDoc(
              agentRun.truncated ? 'truncated' : 'complete',
              agentRun.finalReply,
              tokens
            );
          }
          send({ type: 'complete', reply: agentRun.finalReply, agentRun, ...(activeChatId ? { chatId: activeChatId } : {}) });

          // Contabilidad post-éxito: tokens consumidos + señal de abuso.
          const promptTokens = Number(agentRun.usage?.promptTokens ?? 0) || 0;
          const completionTokens = Number(agentRun.usage?.completionTokens ?? 0) || 0;
          const toolCallCount = agentRun.steps.filter((s) => s.type === 'tool_call').length;
          if (promptTokens > 0 || completionTokens > 0) {
            recordUsage(auth.uid, provider, promptTokens, completionTokens).catch((error) => {
              console.warn('[agora-ai/stream] recordUsage error:', error instanceof Error ? error.message : error);
            });
          }
          logAbuseSignal({
            uid: auth.uid,
            workspaceId,
            model: model || DEFAULT_MODELS[provider],
            toolCallCount,
            promptTokens,
            completionTokens,
            durationMs: Date.now() - startedAt,
            status: agentRun.truncated ? 'truncated' : 'ok'
          });
          close();
        } catch (error) {
          clearTimeout(softTimeout);
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('[agora-ai/stream]', message);
          // Si ya existe el doc assistant, finalizarlo como error con el
          // progreso parcial (steps) antes de cerrar, para que un reload no
          // quede atascado en status:"running".
          await finalizeAssistantDoc('error', '', 0);
          send({ type: 'error', error: message });
          logAbuseSignal({
            uid: auth.uid,
            workspaceId,
            model: model || 'unknown',
            toolCallCount: 0,
            promptTokens: 0,
            completionTokens: 0,
            durationMs: Date.now() - startedAt,
            status: 'error'
          });
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
