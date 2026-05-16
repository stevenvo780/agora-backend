/**
 * st_formalize — convierte prosa libre en español a una fórmula ST sencilla.
 *
 * v1 muy heurística: detecta conectivos básicos ("si...entonces", "no",
 * "y", "o", "si y solo si"). Si la confianza es < 0.5 retorna
 * { suggestion: null, confidence, message } para que el modelo sepa que
 * debe pedir clarificación al usuario. Para textos largos o ambiguos
 * existe `formalize_text` (autologic NLP) que es más sofisticado.
 */
import type { AgentToolCall, AgentExecutionContext, AgentToolExecutionResult } from '@/lib/agora-ai/types';
import { ok } from '../shared';
import { readRequiredString, resolveProfile, type ProfileName } from './shared';

export interface STFormalizeOutput {
  confidence: number;
  suggestion: string | null;
  profile: ProfileName;
  message: string;
  detectedConnectives: string[];
  proseText: string;
}

/**
 * Convierte el sub-texto de un atom a un identificador snake_case ascii
 * apto para ST (P, Q, llueve_mucho, suelo_mojado, etc.).
 */
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

const CONFIDENCE_FLOOR = 0.5;
const CONFIDENCE_CEILING = 0.9;

/**
 * Intenta los patrones por orden de especificidad y devuelve el primero
 * que matchee. Cada patrón asigna su propia confidence.
 */
function tryPatterns(text: string): MatchResult | null {
  const lower = text.toLowerCase().trim().replace(/[.;]+\s*$/, '');

  // 1. "si y solo si": biconditional. Más específico que "si...entonces".
  const biMatch = lower.match(/^(.+?)\s+si\s+y\s+s[oó]lo\s+si\s+(.+)$/i);
  if (biMatch && biMatch[1] && biMatch[2]) {
    const lhs = toAtomId(biMatch[1]);
    const rhs = toAtomId(biMatch[2]);
    return { formula: `${lhs} ↔ ${rhs}`, confidence: 0.75, connectives: ['biconditional'] };
  }

  // 2. "si X entonces Y": implicación.
  const condMatch = lower.match(/^si\s+(.+?)\s+entonces\s+(.+)$/i);
  if (condMatch && condMatch[1] && condMatch[2]) {
    const ant = formalizeSubExpr(condMatch[1]);
    const cons = formalizeSubExpr(condMatch[2]);
    return {
      formula: `${ant.formula} → ${cons.formula}`,
      confidence: Math.min(CONFIDENCE_CEILING, 0.55 + Math.min(ant.confidence, cons.confidence) * 0.3),
      connectives: ['implies', ...ant.connectives, ...cons.connectives]
    };
  }

  // 3. "X o Y": disyunción (también captura "X o bien Y").
  const orMatch = lower.match(/^(.+?)\s+o(?:\s+bien)?\s+(.+)$/i);
  if (orMatch && orMatch[1] && orMatch[2]) {
    const lhs = formalizeSubExpr(orMatch[1]);
    const rhs = formalizeSubExpr(orMatch[2]);
    return {
      formula: `${lhs.formula} ∨ ${rhs.formula}`,
      confidence: 0.55,
      connectives: ['or', ...lhs.connectives, ...rhs.connectives]
    };
  }

  // 4. "X y Y": conjunción.
  const andMatch = lower.match(/^(.+?)\s+y\s+(.+)$/i);
  if (andMatch && andMatch[1] && andMatch[2]) {
    const lhs = formalizeSubExpr(andMatch[1]);
    const rhs = formalizeSubExpr(andMatch[2]);
    return {
      formula: `${lhs.formula} ∧ ${rhs.formula}`,
      confidence: 0.55,
      connectives: ['and', ...lhs.connectives, ...rhs.connectives]
    };
  }

  // 5. "no X" / "no es el caso que X": negación.
  const notMatch = lower.match(/^no\s+(?:es\s+el\s+caso\s+que\s+)?(.+)$/i);
  if (notMatch && notMatch[1]) {
    const inner = formalizeSubExpr(notMatch[1]);
    return {
      formula: `¬${inner.formula}`,
      confidence: 0.55,
      connectives: ['not', ...inner.connectives]
    };
  }

  // 6. Átomo solo: confianza baja porque no detectamos estructura.
  return { formula: toAtomId(lower), confidence: 0.35, connectives: [] };
}

/**
 * Versión recursiva que envuelve sub-expresiones en paréntesis cuando es
 * necesario para que el resultado sea ST-parseable.
 */
function formalizeSubExpr(text: string): MatchResult {
  const r = tryPatterns(text);
  if (!r) return { formula: toAtomId(text), confidence: 0.35, connectives: [] };
  const needsParens = r.connectives.length > 0;
  return {
    ...r,
    formula: needsParens && !r.formula.startsWith('¬') ? `(${r.formula})` : r.formula
  };
}

export async function stFormalize(call: AgentToolCall, _ctx: AgentExecutionContext): Promise<AgentToolExecutionResult> {
  const proseText = readRequiredString(call.args, 'proseText');
  const profile = resolveProfile(call.args.hint);

  const match = tryPatterns(proseText);

  if (!match || match.confidence < CONFIDENCE_FLOOR) {
    const output: STFormalizeOutput = {
      confidence: match?.confidence ?? 0,
      suggestion: null,
      profile,
      message: 'La heurística básica no pudo identificar una estructura lógica clara. Reformula la entrada o usa formalize_text para un análisis más profundo.',
      detectedConnectives: match?.connectives ?? [],
      proseText
    };
    return ok(call, output.message, { ...output });
  }

  const output: STFormalizeOutput = {
    confidence: Math.min(CONFIDENCE_CEILING, match.confidence),
    suggestion: match.formula,
    profile,
    message: `Sugerencia formal (heurística): ${match.formula}`,
    detectedConnectives: match.connectives,
    proseText
  };
  return ok(call, output.message, { ...output });
}
