/**
 * Tests del módulo belnap-aware.
 *
 * Cubren los tres casos de la especificación Fase γ4:
 *   1. Fórmula P en perfil Belnap → value='both', consistency='inconsistent'.
 *      (P es contingente con fila B=B en la tabla cuadrivaluada, reflejando
 *      que la base puede contener P y ¬P simultáneamente.)
 *   2. P → P en cualquier perfil → value='T', consistency='consistent'.
 *      (Tautología clásica, comportamiento idéntico en Belnap.)
 *   3. P ∧ ¬P en perfil Belnap → value='both', consistency='inconsistent'.
 *      (Clásicamente insatisfacible, pero en Belnap tiene fila B→B.)
 *
 * También se prueban adaptStrategy y los casos de perfil no-Belnap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeBelnap,
  adaptStrategy
} from '../../../src/lib/agora-ai/belnap-aware/index.ts';
import type { BelnapAnalysis } from '../../../src/lib/agora-ai/belnap-aware/index.ts';

const BELNAP = 'paraconsistent.belnap';
const CLASSICAL = 'classical.propositional';

// ── analyzeBelnap ────────────────────────────────────────────────────────────

test('analyzeBelnap: P en perfil Belnap → value=both, consistency=inconsistent', async () => {
  const result = await analyzeBelnap('P', BELNAP);
  assert.equal(result.value, 'both');
  assert.equal(result.consistency, 'inconsistent');
  assert.ok(result.recommendation.length > 0, 'recommendation no debe estar vacía');
  assert.ok(Array.isArray(result.suggestedTactics) && result.suggestedTactics.length > 0,
    'suggestedTactics debe tener al menos una táctica');
});

test('analyzeBelnap: P → P → value=T, consistency=consistent', async () => {
  const result = await analyzeBelnap('P -> P', BELNAP);
  assert.equal(result.value, 'T');
  assert.equal(result.consistency, 'consistent');
});

test('analyzeBelnap: P → P en perfil clásico también es T', async () => {
  const result = await analyzeBelnap('P -> P', CLASSICAL);
  assert.equal(result.value, 'T');
  assert.equal(result.consistency, 'consistent');
});

test('analyzeBelnap: P ∧ ¬P en perfil Belnap → value=both, consistency=inconsistent', async () => {
  const result = await analyzeBelnap('P & ~P', BELNAP);
  assert.equal(result.value, 'both');
  assert.equal(result.consistency, 'inconsistent');
});

test('analyzeBelnap: P ∧ ¬P en perfil clásico → value=F, consistency=consistent', async () => {
  const result = await analyzeBelnap('P & ~P', CLASSICAL);
  assert.equal(result.value, 'F');
  assert.equal(result.consistency, 'consistent');
});

test('analyzeBelnap: tautología compleja Q → (P → Q) en Belnap → T', async () => {
  const result = await analyzeBelnap('Q -> (P -> Q)', BELNAP);
  assert.equal(result.value, 'T');
  assert.equal(result.consistency, 'consistent');
});

test('analyzeBelnap: contingencia P ∨ Q en Belnap → both (fila B disponible)', async () => {
  const result = await analyzeBelnap('P | Q', BELNAP);
  // P|Q tiene fila B (B|F=B, B|B=B) → 'both'
  assert.equal(result.value, 'both');
  assert.equal(result.consistency, 'inconsistent');
});

// ── recomendaciones por cuadrante ────────────────────────────────────────────

test('analyzeBelnap: T incluye recomendación de axioma', async () => {
  const result = await analyzeBelnap('P -> P', BELNAP);
  assert.ok(
    result.recommendation.toLowerCase().includes('axioma') ||
    result.recommendation.toLowerCase().includes('premisa'),
    `recommendation para T debe mencionar axioma/premisa; obtenido: "${result.recommendation}"`
  );
});

test('analyzeBelnap: F incluye recomendación de negación', async () => {
  const result = await analyzeBelnap('P & ~P', CLASSICAL);
  assert.ok(
    result.recommendation.toLowerCase().includes('negaci'),
    `recommendation para F debe mencionar negación; obtenido: "${result.recommendation}"`
  );
});

test('analyzeBelnap: both incluye recomendación de contradicción', async () => {
  const result = await analyzeBelnap('P & ~P', BELNAP);
  assert.ok(
    result.recommendation.toLowerCase().includes('contradicción') ||
    result.recommendation.toLowerCase().includes('contradictoria'),
    `recommendation para both debe mencionar contradicción; obtenido: "${result.recommendation}"`
  );
});

test('analyzeBelnap: neither incluye recomendación de información', async () => {
  // Para obtener 'neither' con perfil no-Belnap: fórmula contingente
  const result = await analyzeBelnap('P', CLASSICAL);
  // P clásico: satisfacible pero no válido → 'neither'
  assert.equal(result.value, 'neither');
  assert.equal(result.consistency, 'incomplete');
  assert.ok(
    result.recommendation.toLowerCase().includes('información') ||
    result.recommendation.toLowerCase().includes('perspectiva'),
    `recommendation para neither debe mencionar información/perspectiva; obtenido: "${result.recommendation}"`
  );
});

// ── adaptStrategy ────────────────────────────────────────────────────────────

test('adaptStrategy: T → primaryGoal menciona axioma/consolidar', async () => {
  const analysis: BelnapAnalysis = await analyzeBelnap('P -> P', BELNAP);
  const strategy = adaptStrategy(analysis);
  assert.ok(typeof strategy.primaryGoal === 'string' && strategy.primaryGoal.length > 0);
  assert.ok(Array.isArray(strategy.subgoals) && strategy.subgoals.length > 0,
    'subgoals debe tener al menos un elemento');
  assert.ok(
    strategy.primaryGoal.toLowerCase().includes('axioma') ||
    strategy.primaryGoal.toLowerCase().includes('consolid'),
    `primaryGoal para T debe mencionar axioma/consolidar; obtenido: "${strategy.primaryGoal}"`
  );
});

test('adaptStrategy: F → primaryGoal menciona negación o dependencias', async () => {
  const analysis: BelnapAnalysis = await analyzeBelnap('P & ~P', CLASSICAL);
  const strategy = adaptStrategy(analysis);
  assert.ok(
    strategy.primaryGoal.toLowerCase().includes('negaci') ||
    strategy.primaryGoal.toLowerCase().includes('dependencia'),
    `primaryGoal para F debe mencionar negación/dependencias; obtenido: "${strategy.primaryGoal}"`
  );
  assert.ok(strategy.subgoals.length >= 2, 'F debe tener al menos 2 subgoals');
});

test('adaptStrategy: both → primaryGoal menciona contradicción', async () => {
  const analysis: BelnapAnalysis = await analyzeBelnap('P & ~P', BELNAP);
  const strategy = adaptStrategy(analysis);
  assert.ok(
    strategy.primaryGoal.toLowerCase().includes('contradicción') ||
    strategy.primaryGoal.toLowerCase().includes('contradictoria'),
    `primaryGoal para both debe mencionar contradicción; obtenido: "${strategy.primaryGoal}"`
  );
  assert.ok(strategy.subgoals.length >= 3, 'both debe tener al menos 3 subgoals');
});

test('adaptStrategy: neither → primaryGoal menciona información/clarificar', async () => {
  const analysis: BelnapAnalysis = await analyzeBelnap('P', CLASSICAL);
  const strategy = adaptStrategy(analysis);
  assert.ok(
    strategy.primaryGoal.toLowerCase().includes('información') ||
    strategy.primaryGoal.toLowerCase().includes('clarificar') ||
    strategy.primaryGoal.toLowerCase().includes('adquirir'),
    `primaryGoal para neither debe mencionar información/clarificar; obtenido: "${strategy.primaryGoal}"`
  );
  assert.ok(strategy.subgoals.length >= 2, 'neither debe tener al menos 2 subgoals');
});

test('adaptStrategy: devuelve subgoals como array de strings no vacíos', async () => {
  for (const [formula, profile] of [
    ['P -> P', BELNAP],
    ['P & ~P', CLASSICAL],
    ['P & ~P', BELNAP],
    ['P', CLASSICAL]
  ] as const) {
    const analysis = await analyzeBelnap(formula, profile);
    const strategy = adaptStrategy(analysis);
    assert.ok(Array.isArray(strategy.subgoals), `subgoals debe ser array para ${formula}`);
    for (const sg of strategy.subgoals) {
      assert.ok(typeof sg === 'string' && sg.length > 0,
        `cada subgoal debe ser string no vacío; fórmula=${formula}`);
    }
  }
});
