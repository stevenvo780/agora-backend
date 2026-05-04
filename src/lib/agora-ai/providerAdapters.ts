import { buildAgoraSystemPrompt, extractThinkingSegments } from '@/lib/agora-ai/systemPrompt';
import { toAnthropicTools, toGeminiTools, toOpenAITools } from '@/lib/agora-ai/toolDefinitions';
import { normalizeAgentAccessPolicy, profileAutoConfirms } from '@/lib/agora-ai/accessPolicy';
import { executeAgentTool } from '@/lib/agora-ai/toolExecutor';
import { isCacheableAgentTool, isDestructiveAgentTool } from '@/lib/agora-ai/toolRegistry';
import type {
  AgentExecutionContext,
  AgentMode,
  AgentRun,
  AgentRollbackAction,
  AgentToolCall,
  AgentTraceStep,
  AgentToolExecutionResult,
  AgentUsageStats,
  AIProvider,
  ChatMessage
} from '@/lib/agora-ai/types';

const MAX_AGENT_ITERATIONS = 25;
const BUDGET_SAFETY_MS = 25_000; // 1 round del modelo + tools antes del cutoff

function budgetWillExpire(ctx: AgentExecutionContext): boolean {
  if (!ctx.elapsedBudgetMs || !ctx.maxBudgetMs) return false;
  return ctx.elapsedBudgetMs() + BUDGET_SAFETY_MS >= ctx.maxBudgetMs;
}

/**
 * Costos aproximados por provider/modelo (USD por millón de tokens).
 * Se usa para mostrar un costo estimado al usuario — no es una factura.
 */
const COST_TABLE: Record<string, { input: number; output: number }> = {
  // OpenAI (mini families)
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  // Anthropic
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  // Gemini
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  // DeepSeek
  'deepseek-v4-flash': { input: 0.07, output: 0.27 },
  'deepseek-chat': { input: 0.27, output: 1.10 }
};

function lookupCost(model: string): { input: number; output: number } | null {
  const direct = COST_TABLE[model];
  if (direct) return direct;
  // Fallback: prefix match (e.g., 'gpt-4o-mini-2024-07-18' → 'gpt-4o-mini')
  const prefix = Object.keys(COST_TABLE).find((key) => model.startsWith(key));
  return prefix ? COST_TABLE[prefix]! : null;
}

function accumulateUsage(
  acc: AgentUsageStats,
  provider: AIProvider,
  model: string,
  raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number }
) {
  const inTok = raw.prompt_tokens ?? raw.input_tokens ?? 0;
  const outTok = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const total = raw.total_tokens ?? (inTok + outTok);

  acc.promptTokens = (acc.promptTokens ?? 0) + inTok;
  acc.completionTokens = (acc.completionTokens ?? 0) + outTok;
  acc.totalTokens = (acc.totalTokens ?? 0) + total;

  const cost = lookupCost(model);
  if (cost) {
    const usd = (inTok * cost.input + outTok * cost.output) / 1_000_000;
    acc.estimatedCostUsd = (acc.estimatedCostUsd ?? 0) + usd;
  }
  void provider;
}

interface ProviderRunCallbacks {
  onStep?: (step: AgentTraceStep) => void | Promise<void>;
  onStatus?: (status: string) => void | Promise<void>;
}

interface ProviderRunOptions {
  provider: Exclude<AIProvider, 'ollama'>;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  contextPrompt?: string;
  mode: AgentMode;
  executionContext: AgentExecutionContext;
  callbacks?: ProviderRunCallbacks;
}

type OpenAIToolCall = {
  id: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAICompatibleProviderConfig = {
  endpoint: string;
  label: string;
  echoReasoningContent: boolean;
  supportsToolChoice: boolean;
};

const OPENAI_COMPATIBLE_PROVIDERS: Record<'openai' | 'deepseek', OpenAICompatibleProviderConfig> = {
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    label: 'OpenAI',
    echoReasoningContent: false,
    supportsToolChoice: true
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    label: 'DeepSeek',
    echoReasoningContent: true,
    supportsToolChoice: false
  }
};

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type GeminiPart = {
  text?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
};

const createStep = (step: Omit<AgentTraceStep, 'startedAt'>): AgentTraceStep => ({
  ...step,
  startedAt: Date.now(),
  finishedAt: Date.now()
});

const safeJsonParse = (value: string | undefined): Record<string, unknown> => {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const stringifyToolResult = (result: unknown) => JSON.stringify(result, null, 2);

const toolExecutionStatus = (toolCalls: AgentToolCall[]) => {
  const firstToolCall = toolCalls[0];
  if (toolCalls.length > 1) return `Ejecutando ${toolCalls.length} herramientas en paralelo…`;
  return firstToolCall ? `Ejecutando ${firstToolCall.name}…` : 'Sin herramientas para ejecutar…';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryAt = Date.parse(retryAfter);
  if (!Number.isNaN(retryAt)) return Math.max(0, retryAt - Date.now());
  return null;
}

function shouldRetryProviderStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function isNonRetryableRateLimit(response: Response) {
  if (response.status !== 429) return false;
  const body = await response.clone().text().catch(() => '');
  return /\b(quota|billing|credits?|insufficient_quota|payment)\b/i.test(body);
}

function providerRetryDelayMs(attempt: number, response?: Response) {
  const retryAfterMs = response ? parseRetryAfterMs(response.headers) : null;
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 10000);
  const base = Math.min(800 * (2 ** (attempt - 1)), 8000);
  return base + Math.floor(Math.random() * 350);
}

async function fetchProviderWithRetry(
  provider: string,
  input: RequestInfo | URL,
  init: RequestInit,
  emitStatus: (status: string) => Promise<void>,
  maxAttempts = 4
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (
        !shouldRetryProviderStatus(response.status)
        || attempt >= maxAttempts
        || await isNonRetryableRateLimit(response)
      ) {
        return response;
      }
      const delay = providerRetryDelayMs(attempt, response);
      await response.text().catch(() => undefined);
      await emitStatus(`${provider} respondió ${response.status}; reintento ${attempt + 1}/${maxAttempts} en ${Math.round(delay / 1000)}s…`);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const delay = providerRetryDelayMs(attempt);
      await emitStatus(`${provider} tuvo un fallo de red; reintento ${attempt + 1}/${maxAttempts} en ${Math.round(delay / 1000)}s…`);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `No se pudo contactar ${provider}`));
}

const firstToolResultSummary = (
  toolResults: Array<{ toolCall: AgentToolCall; result: AgentToolExecutionResult }>
) => toolResults[0]?.result.summary ?? '';

/**
 * Parse structured error bodies from AI provider APIs and return a
 * user-friendly Spanish message that includes rate-limit / quota hints.
 */
async function parseProviderError(provider: string, status: number, body: string): Promise<string> {
  const hint =
    status === 401 ? ' — API key inválida o expirada.' :
    status === 429 ? ' — límite de peticiones alcanzado, espera unos segundos.' :
    status === 402 || status === 403 ? ' — cuota agotada o sin créditos.' :
    '';
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const err = data.error as Record<string, string> | undefined;
    if (err?.message) return `${provider} ${status}: ${err.message}${hint}`;
  } catch { /* not JSON */ }
  return `${provider} ${status}: ${body.slice(0, 300)}${hint}`;
}

function createEmitters(steps: AgentTraceStep[], callbacks?: ProviderRunCallbacks) {
  return {
    emitStatus: async (status: string) => {
      await callbacks?.onStatus?.(status);
    },
    emitStep: async (step: AgentTraceStep) => {
      steps.push(step);
      await callbacks?.onStep?.(step);
    }
  };
}

async function collectTextAndThinking(
  rawContent: string,
  emitStep: (step: AgentTraceStep) => Promise<void>
) {
  const { thinking, visible } = extractThinkingSegments(rawContent || '');
  if (thinking) {
    await emitStep(createStep({
      id: `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'thinking',
      title: 'Razonamiento del agente',
      content: thinking
    }));
  }
  if (visible) {
    await emitStep(createStep({
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'plan',
      title: 'Plan / respuesta intermedia',
      content: visible
    }));
  }
  return visible;
}

/**
 * Execute tool calls with bounded concurrency and return results in original order.
 * allSettled semantics keep one tool failure from blocking the rest.
 */
function toolCacheKey(call: AgentToolCall): string | null {
  if (!isCacheableAgentTool(call.name)) return null;
  try { return `${call.name}::${JSON.stringify(call.args ?? {})}`; }
  catch { return null; }
}

async function executeToolsParallel(
  toolCalls: AgentToolCall[],
  executionContext: AgentExecutionContext,
  cache?: Map<string, AgentToolExecutionResult>
): Promise<Array<{ toolCall: AgentToolCall; result: AgentToolExecutionResult }>> {
  // En perfiles que auto-confirman (god mode): saltar el modal por-tool inyectando
  // confirmed:true en destructivas, y no aplicar el batch-block — el agente ejecuta
  // sin pausas como anuncia el perfil.
  const autoConfirms = profileAutoConfirms(
    normalizeAgentAccessPolicy(executionContext.accessPolicy).profile
  );
  if (autoConfirms) {
    toolCalls = toolCalls.map((c) => isDestructiveAgentTool(c.name)
      ? { ...c, args: { ...(c.args ?? {}), confirmed: true } }
      : c);
  }

  // Salvaguarda: si el batch contiene 2+ tools destructivas, rechazamos las
  // posteriores y dejamos que la primera pida confirmación de forma natural.
  // No aplica cuando el perfil auto-confirma (no hay modal que esperar).
  const destructiveBatch = autoConfirms
    ? []
    : toolCalls.filter((c) => isDestructiveAgentTool(c.name));
  const blockedDestructive = destructiveBatch.length > 1
    ? new Set(destructiveBatch.slice(1).map((c) => c.id))
    : new Set<string>();
  const concurrency = Math.min(8, Math.max(1, toolCalls.length));
  const settled: Array<PromiseSettledResult<AgentToolExecutionResult> | undefined> = new Array(toolCalls.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < toolCalls.length) {
      const index = nextIndex;
      nextIndex += 1;
      const toolCall = toolCalls[index];
      if (!toolCall) continue;
      if (blockedDestructive.has(toolCall.id)) {
        settled[index] = {
          status: 'fulfilled',
          value: {
            ok: false,
            name: toolCall.name,
            callId: toolCall.id,
            summary: `Bloqueado: ${toolCall.name} hace parte de un batch destructivo. Confirma primero la otra acción destructiva del turno antes de ejecutar esta.`,
            error: 'destructive_batch_blocked'
          }
        };
        continue;
      }
      const cacheKey = cache ? toolCacheKey(toolCall) : null;
      if (cacheKey && cache?.has(cacheKey)) {
        const cached = cache.get(cacheKey)!;
        // Devolvemos una copia con el callId actualizado para que el provider
        // empareje correctamente la herramienta esperada.
        settled[index] = {
          status: 'fulfilled',
          value: { ...cached, callId: toolCall.id, cached: true }
        };
        continue;
      }
      settled[index] = await Promise.resolve(executeAgentTool(toolCall, executionContext))
        .then((value): PromiseSettledResult<AgentToolExecutionResult> => {
          if (cacheKey && cache && value.ok) cache.set(cacheKey, value);
          return { status: 'fulfilled', value };
        })
        .catch((reason): PromiseSettledResult<AgentToolExecutionResult> => ({ status: 'rejected', reason }));
    }
  }));

  return toolCalls.map((toolCall, i) => {
    const item = settled[i];
    if (!item) {
      return {
        toolCall,
        result: {
          ok: false,
          name: toolCall.name,
          callId: toolCall.id,
          summary: `Error inesperado ejecutando ${toolCall.name}: resultado ausente`,
          error: 'Resultado de herramienta ausente'
        } as AgentToolExecutionResult
      };
    }
    if (item.status === 'fulfilled') return { toolCall, result: item.value };
    return {
      toolCall,
      result: {
        ok: false,
        name: toolCall.name,
        callId: toolCall.id,
        summary: `Error inesperado ejecutando ${toolCall.name}: ${String(item.reason)}`,
        error: String(item.reason)
      } as AgentToolExecutionResult
    };
  });
}

async function runOpenAI(options: ProviderRunOptions): Promise<AgentRun> {
  const providerConfig = options.provider === 'deepseek'
    ? OPENAI_COMPATIBLE_PROVIDERS.deepseek
    : OPENAI_COMPATIBLE_PROVIDERS.openai;
  const steps: AgentTraceStep[] = [];
  const rollback: AgentRollbackAction[] = [];
  const { emitStatus, emitStep } = createEmitters(steps, options.callbacks);
  const systemPrompt = buildAgoraSystemPrompt({
    mode: options.mode,
    contextPrompt: options.contextPrompt,
    workspaceId: options.executionContext.workspaceId,
    accessPolicy: options.executionContext.accessPolicy
  });

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    ...options.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }))
  ];

  let finalReply = '';
  let iterations = 0;
  let pendingConfirmation: AgentRun['pendingConfirmation'];
  let truncated = false;
  const usage: AgentUsageStats = {};
  const toolCache = new Map<string, AgentToolExecutionResult>();

  for (iterations = 1; iterations <= MAX_AGENT_ITERATIONS; iterations += 1) {
    if (budgetWillExpire(options.executionContext)) {
      truncated = true;
      finalReply = finalReply || `Se interrumpió la ejecución para no exceder el presupuesto de tiempo (iter ${iterations - 1}/${MAX_AGENT_ITERATIONS}).`;
      break;
    }
    await emitStatus(`Consultando ${options.provider} (${iterations}/${MAX_AGENT_ITERATIONS})…`);

    const res = await fetchProviderWithRetry(providerConfig.label, providerConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        max_tokens: 8192,
        ...(options.mode === 'agent'
          ? {
            tools: toOpenAITools(),
            ...(providerConfig.supportsToolChoice ? { tool_choice: 'auto' } : {})
          }
          : {})
      })
    }, emitStatus);

    if (!res.ok) {
      throw new Error(await parseProviderError(providerConfig.label, res.status, await res.text()));
    }

    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAIToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    if (data.usage) accumulateUsage(usage, options.provider, options.model, data.usage);

    const choice = data.choices?.[0];
    const message = choice?.message;
    const rawContent = message?.content ?? '';
    const rawReasoning = message?.reasoning_content;
    if (typeof rawReasoning === 'string' && rawReasoning.trim()) {
      await emitStep(createStep({
        id: `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'thinking',
        title: 'Razonamiento del agente',
        content: rawReasoning
      }));
    }
    const visibleContent = await collectTextAndThinking(rawContent, emitStep);
    const toolCalls = (message?.tool_calls ?? []).map((call): AgentToolCall => ({
      id: call.id,
      name: call.function?.name ?? 'unknown_tool',
      args: safeJsonParse(call.function?.arguments)
    }));

    if (choice?.finish_reason === 'length') {
      finalReply = visibleContent || 'La respuesta fue cortada por el límite de tokens. Simplifica tu solicitud.';
      break;
    }
    if (!toolCalls.length || options.mode !== 'agent') {
      finalReply = visibleContent || finalReply || 'Listo.';
      break;
    }

    // Push assistant turn (before executing tools)
    const assistantTurn: Record<string, unknown> = {
      role: 'assistant',
      content: rawContent || null,
      tool_calls: toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) }
      }))
    };
    if (providerConfig.echoReasoningContent && typeof rawReasoning === 'string') {
      assistantTurn.reasoning_content = rawReasoning;
    }
    messages.push(assistantTurn);

    // Announce & execute all tools concurrently
    await emitStatus(toolExecutionStatus(toolCalls));
    for (const tc of toolCalls) {
      await emitStep(createStep({
        id: `call-${tc.id}`, type: 'tool_call',
        title: `Ejecutando ${tc.name}`, call: tc
      }));
    }

    const toolResults = await executeToolsParallel(toolCalls, options.executionContext, toolCache);

    for (const { toolCall, result } of toolResults) {
      if (result.rollback?.length) rollback.push(...result.rollback);
      await emitStep(createStep({
        id: `result-${toolCall.id}`,
        type: result.ok ? 'tool_result' : 'error',
        title: result.ok ? `Resultado de ${toolCall.name}` : `Error en ${toolCall.name}`,
        result,
        content: result.summary
      }));
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: stringifyToolResult(result)
      });
      if (result.requiresConfirmation && result.pendingConfirmation && !pendingConfirmation) {
        pendingConfirmation = result.pendingConfirmation;
      }
    }

    if (pendingConfirmation) {
      finalReply = visibleContent || firstToolResultSummary(toolResults);
      return {
        mode: options.mode, provider: options.provider,
        iterations, steps, finalReply, pendingConfirmation, rollback
      };
    }
  }

  if (!finalReply) {finalReply = (typeof truncated !== 'undefined' && truncated)
    ? 'La ejecución del agente fue truncada por presupuesto de tiempo.'
    : 'Se completó la ejecución del agente.';}

  await emitStep(createStep({
    id: `final-${steps.length + 1}`,
    type: 'final', title: 'Respuesta final', content: finalReply
  }));

  return {
    mode: options.mode,
    provider: options.provider,
    iterations,
    steps,
    finalReply,
    rollback,
    truncated: typeof truncated !== 'undefined' && truncated ? true : undefined,
    usage: typeof usage !== 'undefined' && Object.keys(usage).length ? usage : undefined
  };
}

/**
 * Models that support native extended thinking (interleaved with tool calls).
 * Haiku models currently do NOT support it.
 */
const supportsNativeThinking = (model: string) =>
  model.includes('sonnet') || model.includes('opus');

async function runAnthropic(options: ProviderRunOptions): Promise<AgentRun> {
  const steps: AgentTraceStep[] = [];
  const rollback: AgentRollbackAction[] = [];
  const { emitStatus, emitStep } = createEmitters(steps, options.callbacks);
  const systemPrompt = buildAgoraSystemPrompt({
    mode: options.mode,
    contextPrompt: options.contextPrompt,
    workspaceId: options.executionContext.workspaceId,
    accessPolicy: options.executionContext.accessPolicy
  });

  const useNativeThinking = supportsNativeThinking(options.model) && options.mode === 'agent';
  // Sonnet/Opus support up to 64K output; cap at 16K (thinking budget + visible headroom).
  const maxTokens = useNativeThinking ? 16000 : 8192;

  const messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> =
    options.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  let finalReply = '';
  let iterations = 0;
  let pendingConfirmation: AgentRun['pendingConfirmation'];
  let truncated = false;
  const usage: AgentUsageStats = {};
  const toolCache = new Map<string, AgentToolExecutionResult>();

  for (iterations = 1; iterations <= MAX_AGENT_ITERATIONS; iterations += 1) {
    if (budgetWillExpire(options.executionContext)) {
      truncated = true;
      finalReply = finalReply || `Se interrumpió la ejecución para no exceder el presupuesto de tiempo (iter ${iterations - 1}/${MAX_AGENT_ITERATIONS}).`;
      break;
    }
    await emitStatus(`Consultando ${options.provider} (${iterations}/${MAX_AGENT_ITERATIONS})…`);

    const res = await fetchProviderWithRetry('Anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
        ...(useNativeThinking ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {})
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        ...(options.mode === 'agent' ? { tools: toAnthropicTools() } : {}),
        ...(useNativeThinking
          ? { thinking: { type: 'enabled', budget_tokens: 10000 } }
          : {})
      })
    }, emitStatus);

    if (!res.ok) {
      throw new Error(await parseProviderError('Anthropic', res.status, await res.text()));
    }

    const data = await res.json() as {
      content?: AnthropicBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const blocks = data.content ?? [];
    if (data.usage) accumulateUsage(usage, options.provider, options.model, data.usage);

    let visibleContent: string;

    if (useNativeThinking) {
      // Native thinking blocks — emit directly without XML tag parsing
      const nativeThinking = blocks
        .filter((b): b is Extract<AnthropicBlock, { type: 'thinking' }> => b.type === 'thinking')
        .map(b => b.thinking)
        .join('\n')
        .trim();
      const text = blocks
        .filter((b): b is Extract<AnthropicBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();

      if (nativeThinking) {
        await emitStep(createStep({
          id: `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'thinking', title: 'Razonamiento del agente', content: nativeThinking
        }));
      }
      visibleContent = text;
      if (visibleContent) {
        await emitStep(createStep({
          id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'plan', title: 'Plan / respuesta intermedia', content: visibleContent
        }));
      }
    } else {
      // Fallback: parse <thinking>...</thinking> tags from text content
      const text = blocks
        .filter((b): b is Extract<AnthropicBlock, { type: 'text' }> => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      visibleContent = await collectTextAndThinking(text, emitStep);
    }

    if (data.stop_reason === 'max_tokens') {
      finalReply = visibleContent || 'La respuesta fue cortada por el límite de tokens. Simplifica tu solicitud.';
      break;
    }

    const toolCalls = blocks
      .filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, args: b.input }));

    if (!toolCalls.length || options.mode !== 'agent') {
      finalReply = visibleContent || finalReply || 'Listo.';
      break;
    }

    // Push full assistant turn — MUST include thinking blocks verbatim for
    // the model to maintain reasoning continuity across turns.
    messages.push({ role: 'assistant', content: blocks });

    // Announce & execute all tools concurrently
    await emitStatus(toolExecutionStatus(toolCalls));
    for (const tc of toolCalls) {
      await emitStep(createStep({
        id: `call-${tc.id}`, type: 'tool_call',
        title: `Ejecutando ${tc.name}`, call: tc
      }));
    }

    const toolResults = await executeToolsParallel(toolCalls, options.executionContext, toolCache);
    const toolResultBlocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

    for (const { toolCall, result } of toolResults) {
      if (result.rollback?.length) rollback.push(...result.rollback);
      await emitStep(createStep({
        id: `result-${toolCall.id}`,
        type: result.ok ? 'tool_result' : 'error',
        title: result.ok ? `Resultado de ${toolCall.name}` : `Error en ${toolCall.name}`,
        result,
        content: result.summary
      }));
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: stringifyToolResult(result)
      });
      if (result.requiresConfirmation && result.pendingConfirmation && !pendingConfirmation) {
        pendingConfirmation = result.pendingConfirmation;
      }
    }

    messages.push({ role: 'user', content: toolResultBlocks });

    if (pendingConfirmation) {
      finalReply = visibleContent || firstToolResultSummary(toolResults);
      return {
        mode: options.mode, provider: options.provider,
        iterations, steps, finalReply, pendingConfirmation, rollback
      };
    }
  }

  if (!finalReply) {finalReply = (typeof truncated !== 'undefined' && truncated)
    ? 'La ejecución del agente fue truncada por presupuesto de tiempo.'
    : 'Se completó la ejecución del agente.';}

  await emitStep(createStep({
    id: `final-${steps.length + 1}`,
    type: 'final', title: 'Respuesta final', content: finalReply
  }));

  return {
    mode: options.mode,
    provider: options.provider,
    iterations,
    steps,
    finalReply,
    rollback,
    truncated: typeof truncated !== 'undefined' && truncated ? true : undefined,
    usage: typeof usage !== 'undefined' && Object.keys(usage).length ? usage : undefined
  };
}

async function runGemini(options: ProviderRunOptions): Promise<AgentRun> {
  const steps: AgentTraceStep[] = [];
  const rollback: AgentRollbackAction[] = [];
  const { emitStatus, emitStep } = createEmitters(steps, options.callbacks);
  const systemPrompt = buildAgoraSystemPrompt({
    mode: options.mode,
    contextPrompt: options.contextPrompt,
    workspaceId: options.executionContext.workspaceId,
    accessPolicy: options.executionContext.accessPolicy
  });

  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> =
    options.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

  let finalReply = '';
  let iterations = 0;
  let pendingConfirmation: AgentRun['pendingConfirmation'];
  let truncated = false;
  const usage: AgentUsageStats = {};
  const toolCache = new Map<string, AgentToolExecutionResult>();

  for (iterations = 1; iterations <= MAX_AGENT_ITERATIONS; iterations += 1) {
    if (budgetWillExpire(options.executionContext)) {
      truncated = true;
      finalReply = finalReply || `Se interrumpió la ejecución para no exceder el presupuesto de tiempo (iter ${iterations - 1}/${MAX_AGENT_ITERATIONS}).`;
      break;
    }
    await emitStatus(`Consultando ${options.provider} (${iterations}/${MAX_AGENT_ITERATIONS})…`);

    const res = await fetchProviderWithRetry(
      'Gemini',
      `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent?key=${options.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { maxOutputTokens: 8192 },
          ...(options.mode === 'agent' ? { tools: toGeminiTools() } : {})
        })
      },
      emitStatus
    );

    if (!res.ok) {
      throw new Error(await parseProviderError('Gemini', res.status, await res.text()));
    }

    const data = await res.json() as {
      candidates?: Array<{
        content?: { parts?: GeminiPart[] };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    if (data.usageMetadata) {
      accumulateUsage(usage, options.provider, options.model, {
        prompt_tokens: data.usageMetadata.promptTokenCount,
        completion_tokens: data.usageMetadata.candidatesTokenCount,
        total_tokens: data.usageMetadata.totalTokenCount
      });
    }

    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      finalReply = finalReply || 'Respuesta bloqueada por las políticas de seguridad de Gemini.';
      break;
    }

    const parts = candidate?.content?.parts ?? [];
    const text = parts.map(p => p.text || '').join('\n').trim();
    const visibleContent = await collectTextAndThinking(text, emitStep);

    const toolCalls = parts
      .filter(p => p.functionCall?.name)
      .map((p, index): AgentToolCall => ({
        id: `gemini-call-${iterations}-${index + 1}`,
        name: p.functionCall?.name || 'unknown_tool',
        args: p.functionCall?.args || {}
      }));

    if (!toolCalls.length || options.mode !== 'agent') {
      finalReply = visibleContent || finalReply || 'Listo.';
      break;
    }

    // Push model turn (includes function call parts)
    contents.push({ role: 'model', parts: parts as Array<Record<string, unknown>> });

    // Announce & execute all tools concurrently
    await emitStatus(toolExecutionStatus(toolCalls));
    for (const tc of toolCalls) {
      await emitStep(createStep({
        id: `call-${tc.id}`, type: 'tool_call',
        title: `Ejecutando ${tc.name}`, call: tc
      }));
    }

    const toolResults = await executeToolsParallel(toolCalls, options.executionContext, toolCache);
    const functionResponses: Array<Record<string, unknown>> = [];

    for (const { toolCall, result } of toolResults) {
      if (result.rollback?.length) rollback.push(...result.rollback);
      await emitStep(createStep({
        id: `result-${toolCall.id}`,
        type: result.ok ? 'tool_result' : 'error',
        title: result.ok ? `Resultado de ${toolCall.name}` : `Error en ${toolCall.name}`,
        result,
        content: result.summary
      }));
      functionResponses.push({
        functionResponse: { name: toolCall.name, response: result }
      });
      if (result.requiresConfirmation && result.pendingConfirmation && !pendingConfirmation) {
        pendingConfirmation = result.pendingConfirmation;
      }
    }

    contents.push({ role: 'user', parts: functionResponses });

    if (pendingConfirmation) {
      finalReply = visibleContent || firstToolResultSummary(toolResults);
      return {
        mode: options.mode, provider: options.provider,
        iterations, steps, finalReply, pendingConfirmation, rollback
      };
    }
  }

  if (!finalReply) {finalReply = (typeof truncated !== 'undefined' && truncated)
    ? 'La ejecución del agente fue truncada por presupuesto de tiempo.'
    : 'Se completó la ejecución del agente.';}

  await emitStep(createStep({
    id: `final-${steps.length + 1}`,
    type: 'final', title: 'Respuesta final', content: finalReply
  }));

  return {
    mode: options.mode,
    provider: options.provider,
    iterations,
    steps,
    finalReply,
    rollback,
    truncated: typeof truncated !== 'undefined' && truncated ? true : undefined,
    usage: typeof usage !== 'undefined' && Object.keys(usage).length ? usage : undefined
  };
}

export async function runProviderConversation(options: ProviderRunOptions): Promise<AgentRun> {
  switch (options.provider) {
    case 'openai': return runOpenAI(options);
    case 'deepseek': return runOpenAI(options);
    case 'anthropic': return runAnthropic(options);
    case 'gemini': return runGemini(options);
    default:
      throw new Error(`Proveedor no soportado por el servidor: ${options.provider}`);
  }
}
