/**
 * auto-formalize — wrapper unificado que decide entre la heurística regex de
 * st_formalize y el motor LLM de formalize_text (autologic), calibrando un
 * confidence score normalizado 0-1 para ambas fuentes.
 *
 * Lógica de decisión:
 *  1. Si el texto contiene conectivos lógicos reconocibles, intenta la
 *     heurística primero (rápido, sin llamada externa).
 *  2. Si confidence heurística < 0.6 o bien opts.preferLLM es true,
 *     invoca el motor autologic.
 *  3. Devuelve el candidato con mayor confidence, indicando la fuente.
 */

import { formalize as formalizeNLP, type LogicProfile } from '@stevenvo780/autologic';

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface FormalizationAttempt {
  source: 'heuristic' | 'llm' | 'hybrid';
  suggestion: string | null;
  /** Confidence normalizado 0-1. */
  confidence: number;
  alternativeSuggestions?: string[];
  detectedConnectives?: string[];
  reasoning?: string;
}

export interface AutoFormalizeOptions {
  language?: 'es' | 'en';
  /** Si true, siempre invoca el motor LLM aunque la heurística tenga alta confianza. */
  preferLLM?: boolean;
  /** Perfil lógico ST. Por defecto 'classical.propositional'. */
  profile?: string;
}

// ── Umbral de corte para decidir si invocar el LLM ───────────────────────────

const HEURISTIC_CONFIDENCE_THRESHOLD = 0.6;

// ── Conectivos que disparan el intento heurístico primero ────────────────────

const CONNECTIVE_PATTERNS_ES: RegExp[] = [
  /\bsi\b.*\bentonces\b/i,
  /\bsi\s+y\s+s[oó]lo\s+si\b/i,
  /\bno\s+es\s+el\s+caso\b/i,
  /^\s*no\s+/i,
  /\s+y\s+/i,
  /\s+o(?:\s+bien)?\s+/i,
];

const CONNECTIVE_PATTERNS_EN: RegExp[] = [
  /\bif\b.*\bthen\b/i,
  /\bif\s+and\s+only\s+if\b/i,
  /\bnot\s+the\s+case\b/i,
  /^\s*not\s+/i,
  /\s+and\s+/i,
  /\s+or\s+/i,
];

function hasKnownConnectives(text: string, language: 'es' | 'en'): boolean {
  const patterns = language === 'en' ? CONNECTIVE_PATTERNS_EN : CONNECTIVE_PATTERNS_ES;
  return patterns.some((p) => p.test(text));
}

// ── Heurística (reutiliza la lógica de tryPatterns de formalize.ts) ──────────
// Importamos solo el núcleo puro, sin depender de AgentToolCall/AgentExecutionContext.

function toAtomId(text: string): string {
  const trimmed = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s_]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return trimmed || 'p';
}

interface MatchResult {
  formula: string;
  confidence: number;
  connectives: string[];
}

const CONFIDENCE_CEILING = 0.9;

function formalizeSubExpr(text: string): MatchResult {
  const r = tryPatterns(text);
  if (!r) return { formula: toAtomId(text), confidence: 0.35, connectives: [] };
  const needsParens = r.connectives.length > 0;
  return {
    ...r,
    formula: needsParens && !r.formula.startsWith('¬') ? `(${r.formula})` : r.formula
  };
}

function tryPatterns(text: string): MatchResult | null {
  const lower = text.toLowerCase().trim().replace(/[.;]+\s*$/, '');

  const biMatch = lower.match(/^(.+?)\s+si\s+y\s+s[oó]lo\s+si\s+(.+)$/i);
  if (biMatch?.[1] && biMatch[2]) {
    return { formula: `${toAtomId(biMatch[1])} ↔ ${toAtomId(biMatch[2])}`, confidence: 0.75, connectives: ['biconditional'] };
  }

  const condMatch = lower.match(/^si\s+(.+?)\s+entonces\s+(.+)$/i);
  if (condMatch?.[1] && condMatch[2]) {
    const ant = formalizeSubExpr(condMatch[1]);
    const cons = formalizeSubExpr(condMatch[2]);
    return {
      formula: `${ant.formula} → ${cons.formula}`,
      confidence: Math.min(CONFIDENCE_CEILING, 0.55 + Math.min(ant.confidence, cons.confidence) * 0.3),
      connectives: ['implies', ...ant.connectives, ...cons.connectives]
    };
  }

  const orMatch = lower.match(/^(.+?)\s+o(?:\s+bien)?\s+(.+)$/i);
  if (orMatch?.[1] && orMatch[2]) {
    const lhs = formalizeSubExpr(orMatch[1]);
    const rhs = formalizeSubExpr(orMatch[2]);
    return {
      formula: `${lhs.formula} ∨ ${rhs.formula}`,
      confidence: 0.55,
      connectives: ['or', ...lhs.connectives, ...rhs.connectives]
    };
  }

  const andMatch = lower.match(/^(.+?)\s+y\s+(.+)$/i);
  if (andMatch?.[1] && andMatch[2]) {
    const lhs = formalizeSubExpr(andMatch[1]);
    const rhs = formalizeSubExpr(andMatch[2]);
    return {
      formula: `${lhs.formula} ∧ ${rhs.formula}`,
      confidence: 0.55,
      connectives: ['and', ...lhs.connectives, ...rhs.connectives]
    };
  }

  const notMatch = lower.match(/^no\s+(?:es\s+el\s+caso\s+que\s+)?(.+)$/i);
  if (notMatch?.[1]) {
    const inner = formalizeSubExpr(notMatch[1]);
    return {
      formula: `¬${inner.formula}`,
      confidence: 0.55,
      connectives: ['not', ...inner.connectives]
    };
  }

  return { formula: toAtomId(lower), confidence: 0.35, connectives: [] };
}

function runHeuristic(text: string): FormalizationAttempt {
  const match = tryPatterns(text);
  if (!match || match.confidence < 0.5) {
    return {
      source: 'heuristic',
      suggestion: null,
      confidence: match?.confidence ?? 0,
      detectedConnectives: match?.connectives ?? [],
      reasoning: 'Heurística: sin estructura lógica reconocible.'
    };
  }
  return {
    source: 'heuristic',
    suggestion: match.formula,
    confidence: Math.min(CONFIDENCE_CEILING, match.confidence),
    detectedConnectives: match.connectives,
    reasoning: `Heurística: patrón ${match.connectives[0] ?? 'atom'} detectado.`
  };
}

// ── Motor LLM (autologic) ─────────────────────────────────────────────────────

function runLLM(text: string, language: 'es' | 'en', profile: string): FormalizationAttempt {
  try {
    const r = formalizeNLP(text, {
      profile: profile as LogicProfile,
      language,
      atomStyle: 'keywords',
      includeComments: false
    });

    const stCode = r.stCode?.trim() ?? '';
    const rawConfidence = r.ok ? 0.85 : 0.25;

    const patterns: string[] = r.analysis?.detectedPatterns ?? [];
    const atomCount: number = r.atoms?.size ?? 0;

    // Calibración: penalizar si autologic no detectó patrón claro o solo un átomo.
    const calibratedConfidence = r.ok && patterns.length > 0 && atomCount > 1
      ? rawConfidence
      : rawConfidence * 0.7;

    return {
      source: 'llm',
      suggestion: stCode.length > 0 ? stCode : null,
      confidence: Math.min(0.95, calibratedConfidence),
      detectedConnectives: patterns,
      reasoning: `LLM autologic: ok=${r.ok}, patrones=${patterns.join(',') || 'none'}, átomos=${atomCount}.`
    };
  } catch {
    return {
      source: 'llm',
      suggestion: null,
      confidence: 0,
      reasoning: 'LLM autologic: error al formalizar.'
    };
  }
}

// ── Punto de entrada público ──────────────────────────────────────────────────

export async function autoFormalize(
  text: string,
  opts?: AutoFormalizeOptions
): Promise<FormalizationAttempt> {
  const language = opts?.language ?? 'es';
  const profile = opts?.profile ?? 'classical.propositional';
  const preferLLM = opts?.preferLLM ?? false;

  const normalizedText = text.trim();
  if (!normalizedText) {
    return {
      source: 'heuristic',
      suggestion: null,
      confidence: 0,
      reasoning: 'Texto vacío.'
    };
  }

  const hasConnectives = hasKnownConnectives(normalizedText, language);

  // Paso 1: heurística solo si hay conectivos y no se fuerza LLM.
  let heuristicResult: FormalizationAttempt | null = null;
  if (hasConnectives && !preferLLM) {
    heuristicResult = runHeuristic(normalizedText);
    if (heuristicResult.confidence >= HEURISTIC_CONFIDENCE_THRESHOLD) {
      return heuristicResult;
    }
  }

  // Paso 2: LLM.
  const llmResult = runLLM(normalizedText, language, profile);

  // Paso 3: elegir el mejor de los dos.
  if (heuristicResult !== null && heuristicResult.confidence >= llmResult.confidence) {
    return {
      ...heuristicResult,
      source: 'hybrid',
      alternativeSuggestions: llmResult.suggestion ? [llmResult.suggestion] : undefined,
      reasoning: `Hybrid: heurística (${heuristicResult.confidence.toFixed(2)}) ganó a LLM (${llmResult.confidence.toFixed(2)}).`
    };
  }

  if (heuristicResult !== null && llmResult.suggestion !== null) {
    return {
      ...llmResult,
      source: 'hybrid',
      alternativeSuggestions: heuristicResult.suggestion ? [heuristicResult.suggestion] : undefined,
      reasoning: `Hybrid: LLM (${llmResult.confidence.toFixed(2)}) ganó a heurística (${heuristicResult.confidence.toFixed(2)}).`
    };
  }

  return llmResult;
}
