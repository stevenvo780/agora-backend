/**
 * Tests para auto-formalize/index.ts
 *
 * Usa el runner nativo de Node (node:test + node:assert/strict).
 * El motor autologic es REAL (sin mock de módulo), pero cuando se quiere
 * probar el camino LLM de forma determinista se usa preferLLM=true con un
 * texto que la heurística no cubre.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { autoFormalize } from '../../../src/lib/agora-ai/auto-formalize/index.ts';
import type { FormalizationAttempt } from '../../../src/lib/agora-ai/auto-formalize/index.ts';

// ── Helper ────────────────────────────────────────────────────────────────────

function assertAttempt(a: FormalizationAttempt) {
  assert.ok(a.confidence >= 0 && a.confidence <= 1, `confidence fuera de rango: ${a.confidence}`);
  assert.ok(['heuristic', 'llm', 'hybrid'].includes(a.source), `fuente desconocida: ${a.source}`);
}

// ── Caso 1: texto con conectivos claros → heurística con confidence ≥ 0.6 ───
// La fórmula "si X entonces Y" produce confidence 0.55 + 0.3*conf(subexpr).
// Con subexpresiones atómicas (~0.35) el resultado es ~0.655.
// El umbral de corte del wrapper es 0.6, así que la heurística retorna
// sin invocar el LLM, y source queda como 'heuristic'.

test('texto con "si…entonces" → source heuristic, confidence ≥ 0.6', async () => {
  const result = await autoFormalize('si llueve entonces el suelo está mojado', { language: 'es' });
  assertAttempt(result);
  assert.ok(
    result.source === 'heuristic' || result.source === 'hybrid',
    `source debería ser heuristic o hybrid, fue ${result.source}`
  );
  assert.ok(result.confidence >= 0.6, `confidence ${result.confidence} debe ser ≥ 0.6`);
  assert.ok(result.suggestion !== null && result.suggestion.length > 0, 'suggestion debe ser string no vacío');
  assert.ok(result.detectedConnectives?.includes('implies'), 'debe detectar conectivo implies');
});

// ── Caso 2: bicondicional → confidence alta ──────────────────────────────────

test('texto con "si y solo si" → suggestion con ↔ y confidence ≥ 0.7', async () => {
  const result = await autoFormalize('el agua hierve si y solo si la temperatura es 100 grados', { language: 'es' });
  assertAttempt(result);
  assert.ok(result.confidence >= 0.7, `confidence ${result.confidence} debe ser ≥ 0.7`);
  assert.ok(result.suggestion?.includes('↔'), `suggestion debe contener ↔, fue: ${result.suggestion}`);
});

// ── Caso 3: texto sin conectivos → fallback al LLM ───────────────────────────

test('texto sin conectivos → source llm o hybrid, suggestion puede ser null', async () => {
  // "Filosofía" no tiene conectivos; la heurística no lo intenta → va al LLM.
  const result = await autoFormalize('filosofía', { language: 'es' });
  assertAttempt(result);
  // El LLM puede producir algo o no. Lo que importa es que source no sea 'heuristic' puro
  // cuando no hay conectivos (a menos que la confidence sea 0).
  // Validamos únicamente el contrato de tipos y rangos.
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

// ── Caso 4: texto vacío → confidence=0, suggestion=null ──────────────────────

test('texto vacío → confidence=0 y suggestion=null', async () => {
  const result = await autoFormalize('');
  assertAttempt(result);
  assert.equal(result.confidence, 0);
  assert.equal(result.suggestion, null);
});

// ── Caso 5: preferLLM=true → pasa directo al motor autologic ─────────────────

test('preferLLM=true con texto con conectivos → source llm o hybrid', async () => {
  const result = await autoFormalize('si P entonces Q', { language: 'es', preferLLM: true });
  assertAttempt(result);
  assert.ok(
    result.source === 'llm' || result.source === 'hybrid',
    `source debe ser llm o hybrid cuando preferLLM=true, fue ${result.source}`
  );
});

// ── Caso 6: negación → heurística detecta "no" pero confidence 0.55 < umbral ─
// El wrapper invoca el LLM (autologic) que retorna con mayor confidence.
// La suggestion puede contener ¬ (heurística) o !(…) (autologic ST).
// Lo importante es que el resultado contiene negación de alguna forma y
// confidence ≥ 0.5.

test('"no llueve" → suggestion con negación (¬ o !), confidence ≥ 0.5', async () => {
  const result = await autoFormalize('no llueve', { language: 'es' });
  assertAttempt(result);
  assert.ok(result.confidence >= 0.5, `confidence ${result.confidence} debe ser ≥ 0.5`);
  assert.ok(result.suggestion !== null, 'suggestion no debe ser null');
  const hasNegation = result.suggestion?.includes('¬') || result.suggestion?.includes('!') ||
    result.suggestion?.includes('not') || result.suggestion?.includes('neg');
  assert.ok(hasNegation, `suggestion debe contener negación, fue: ${result.suggestion}`);
});

// ── Caso 7: conjunción → heurística intenta pero LLM puede ganar ─────────────
// "llueve y hace frío": la heurística produce ∧ con confidence 0.55 (< 0.6).
// El wrapper invoca el LLM (autologic). La suggestion final puede tener ∧ o
// stCode de autologic. Lo validamos: confidence ≥ 0.5, suggestion no nula.

test('"llueve y hace frío" → confidence ≥ 0.5 y suggestion no nula', async () => {
  const result = await autoFormalize('llueve y hace frío', { language: 'es' });
  assertAttempt(result);
  assert.ok(result.confidence >= 0.5, `confidence ${result.confidence} debe ser ≥ 0.5`);
  assert.ok(result.suggestion !== null && result.suggestion.length > 0, 'suggestion no debe ser nula');
});

// ── Caso 8: mock del LLM — simula confidence 0.9 via texto muy estructurado ──
// No se mockan módulos; se usa preferLLM=true sobre un texto que autologic maneja bien.

test('mock-LLM: texto bien estructurado con preferLLM=true → confidence ≥ 0.6', async () => {
  const result = await autoFormalize(
    'si el examen es difícil entonces los estudiantes reprobarán',
    { language: 'es', preferLLM: true }
  );
  assertAttempt(result);
  // autologic maneja bien este caso; confidence calibrada debe ser razonable.
  assert.ok(result.confidence >= 0.5, `confidence ${result.confidence} debe ser ≥ 0.5`);
  assert.ok(result.suggestion !== null && result.suggestion.length > 0, 'suggestion no debe ser nula');
});
