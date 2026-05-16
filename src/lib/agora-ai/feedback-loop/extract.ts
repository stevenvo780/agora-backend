/**
 * Extrae la "respuesta candidata" que el LLM produce en cada iteración.
 *
 * El LLM puede responder en formato libre, así que aceptamos tres modos:
 *  1. Bloque ```st …``` o ```logic …``` con un fragmento ST.
 *  2. Bloque `<derivation> … </derivation>` con la fórmula objetivo
 *     derivada/probada en una línea propia.
 *  3. Texto libre — se toma la última línea no vacía como candidata.
 *
 * Si nada matchea devolvemos `null` (lo cual marca la iteración como
 * "respuesta no parseable" y dispara re-prompt con guía de formato).
 */

const FENCED_BLOCK = /```(?:st|logic|stlang)?\s*\n([\s\S]*?)```/i;
const DERIVATION_TAG = /<derivation>([\s\S]*?)<\/derivation>/i;

export interface ExtractedCandidate {
  /** Fórmula que el LLM propone como "demostrada" (típicamente igual al goal). */
  formula: string;
  /** Fuente de la extracción (para debug). */
  source: 'fenced' | 'tag' | 'last-line';
}

export function extractCandidate(raw: string): ExtractedCandidate | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  const fenced = raw.match(FENCED_BLOCK);
  if (fenced && typeof fenced[1] === 'string') {
    const inner = fenced[1].trim();
    const lastLine = lastNonEmptyLine(inner);
    if (lastLine) return { formula: lastLine, source: 'fenced' };
  }

  const tagged = raw.match(DERIVATION_TAG);
  if (tagged && typeof tagged[1] === 'string') {
    const inner = tagged[1].trim();
    const lastLine = lastNonEmptyLine(inner);
    if (lastLine) return { formula: lastLine, source: 'tag' };
  }

  const fallback = lastNonEmptyLine(raw);
  if (fallback) return { formula: fallback, source: 'last-line' };

  return null;
}

function lastNonEmptyLine(s: string): string | null {
  const lines = s.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const candidate = lines[lines.length - 1];
  if (typeof candidate !== 'string') return null;
  // Quitamos prefijos comunes que el LLM puede meter ("Q.E.D.", "Goal:", "Conclusion:")
  return candidate
    .replace(/^(?:Q\.?E\.?D\.?|Conclusi[oó]n:|Goal:|Therefore[,:]?|Por\s+tanto[,:]?|Luego[,:]?)\s*/i, '')
    .replace(/^[•*-]\s*/, '')
    .replace(/[.,;]+$/, '')
    .trim();
}
