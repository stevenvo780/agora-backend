import { getContextWindow, getMaxOutputTokens } from '@/lib/agora-ai/modelCatalog';
import type { AIProvider, ChatMessage } from '@/lib/agora-ai/types';

/** Estimación rápida de tokens. ~4 chars por token para texto mixto en/es;
 *  conservador para no infraestimar. */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += (m.content?.length ?? 0) + 8; // overhead role/separadores
  return Math.ceil(chars / 4);
}

export interface CompactionDecision {
  shouldCompact: boolean;
  used: number;
  budget: number;
  ratio: number;
}

export interface CompactionConfig {
  /** Umbral 0-1: cuando used/budget supera esto, comprimir. Default 0.80. */
  threshold?: number;
  /** Cuántos pares user/assistant recientes preservar sin resumir. Default 4. */
  preserveRecentPairs?: number;
  /** Si false, no se llama al modelo: se trunca con un placeholder de aviso. */
  callModelForSummary?: boolean;
}

export function decideCompaction(
  provider: AIProvider | string,
  model: string,
  messages: ChatMessage[],
  outputBudget: number,
  config: CompactionConfig = {}
): CompactionDecision {
  const threshold = clamp01(config.threshold ?? 0.80);
  const ctx = getContextWindow(provider, model);
  // Reservamos espacio para el output esperado.
  const budget = Math.max(1024, ctx - outputBudget);
  const used = estimateMessagesTokens(messages);
  return {
    shouldCompact: used / budget > threshold,
    used,
    budget,
    ratio: used / budget
  };
}

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

const SUMMARY_SYSTEM_PROMPT = [
  'Eres un asistente que resume historiales largos de conversación entre un usuario y un agente de Agora.',
  'Tu tarea: producir un resumen conciso (máx 1500 tokens) preservando, en este orden:',
  '1. Tareas en curso o pendientes que el agente debía completar.',
  '2. Decisiones tomadas por el usuario y restricciones acordadas.',
  '3. Resultados clave de tools ya ejecutadas (ids de documentos creados/borrados, commits hechos, paneles abiertos).',
  '4. Errores no resueltos o confirmaciones pendientes.',
  '',
  'NO inventes información. Si un dato no aparece en la conversación, omítelo.',
  'Devuelve solo el resumen en español, en bullets cortos. Sin preámbulo ni epílogo.'
].join('\n');

export interface SummaryProvider {
  /** Llama al provider para generar texto sin tools, max_tokens limitado. */
  summarize(input: { systemPrompt: string; messages: ChatMessage[]; maxTokens: number }): Promise<string>;
}

/** Compacta el historial. Mantiene `system` original + último `preserveRecentPairs * 2` turnos +
 *  un nuevo mensaje system con el resumen del rango medio. */
export async function compactMessages(
  messages: ChatMessage[],
  summaryProvider: SummaryProvider,
  config: CompactionConfig = {}
): Promise<{ compacted: ChatMessage[]; summary: string; removedCount: number }> {
  const preservePairs = Math.max(1, config.preserveRecentPairs ?? 4);
  const callModel = config.callModelForSummary !== false;

  // Separamos: prelude (mensajes system iniciales) | middle | recent.
  const firstNonSystem = messages.findIndex((m) => m.role !== 'system');
  const prelude = firstNonSystem === -1 ? messages : messages.slice(0, firstNonSystem);
  const body = firstNonSystem === -1 ? [] : messages.slice(firstNonSystem);

  // Tomamos los últimos preservePairs*2 mensajes (incluyendo system intercalados) como "recientes".
  const recentCount = Math.min(body.length, preservePairs * 2);
  const recent = body.slice(body.length - recentCount);
  const middle = body.slice(0, body.length - recentCount);

  if (middle.length === 0) {
    return { compacted: messages, summary: '', removedCount: 0 };
  }

  const summary = callModel
    ? await summaryProvider.summarize({
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: middle,
        maxTokens: 1500
      }).catch((err) => fallbackSummary(middle, err))
    : fallbackSummary(middle, null);

  const summaryMessage: ChatMessage = {
    role: 'system',
    content: `[Resumen de conversación previa — ${middle.length} mensajes comprimidos]\n\n${summary}`
  };

  return {
    compacted: [...prelude, summaryMessage, ...recent],
    summary,
    removedCount: middle.length
  };
}

function fallbackSummary(middle: ChatMessage[], err: unknown): string {
  const head = middle.slice(0, 6).map((m) => `- ${m.role}: ${truncate(m.content, 200)}`).join('\n');
  const tail = middle.slice(-6).map((m) => `- ${m.role}: ${truncate(m.content, 200)}`).join('\n');
  const reason = err instanceof Error ? err.message : 'compactación sin modelo';
  return `(Compactación local — ${reason})\n\nInicio:\n${head}\n\n...\n\nFinal:\n${tail}`;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Helper de alto nivel: decide+compacta. Si no hace falta compactar, devuelve los
 *  mensajes intactos y `compacted: false`. */
export async function maybeCompact(
  provider: AIProvider | string,
  model: string,
  messages: ChatMessage[],
  summaryProvider: SummaryProvider,
  config: CompactionConfig = {}
): Promise<{ messages: ChatMessage[]; compacted: boolean; decision: CompactionDecision; summary?: string; removedCount?: number }> {
  const outputBudget = getMaxOutputTokens(provider, model);
  const decision = decideCompaction(provider, model, messages, outputBudget, config);
  if (!decision.shouldCompact) {
    return { messages, compacted: false, decision };
  }
  const result = await compactMessages(messages, summaryProvider, config);
  return {
    messages: result.compacted,
    compacted: true,
    decision,
    summary: result.summary,
    removedCount: result.removedCount
  };
}
