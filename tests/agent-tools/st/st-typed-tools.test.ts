import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stCheck,
  stDerive,
  stCountermodel,
  stFormalize
} from '../../../src/lib/agora-ai/toolExecutors/st-typed/index.ts';
import type {
  AgentToolCall,
  AgentExecutionContext
} from '../../../src/lib/agora-ai/types.ts';

const ctx: AgentExecutionContext = {
  workspaceId: 'ws-test',
  uid: 'uid-test'
};

const call = (name: string, args: Record<string, unknown>): AgentToolCall => ({
  id: `${name}-1`,
  name,
  args
});

// ── st_check ─────────────────────────────────────────────────────

test('st_check: P → P es válido (sat)', async () => {
  const result = await stCheck(call('st_check', { formula: 'P -> P' }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { valid: boolean; result: string; errors: unknown[] };
  assert.equal(data.valid, true);
  assert.equal(data.result, 'sat');
});

test('st_check: P ∧ ¬P es contradicción (unsat, valid=false)', async () => {
  const result = await stCheck(call('st_check', { formula: 'P & ~P' }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { valid: boolean; result: string };
  assert.equal(data.valid, false);
  assert.equal(data.result, 'unsat');
});

test('st_check: perfil inválido cae a default classical.propositional', async () => {
  const result = await stCheck(call('st_check', { formula: 'P -> P', profile: 'no-existe' }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { profile: string; valid: boolean };
  assert.equal(data.profile, 'classical.propositional');
  assert.equal(data.valid, true);
});

// ── st_derive ────────────────────────────────────────────────────

test('st_derive: modus ponens (P, P → Q ⊢ Q) → valid', async () => {
  const result = await stDerive(call('st_derive', {
    premises: ['P', 'P -> Q'],
    goal: 'Q'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { valid: boolean; steps: Array<{ stepNumber: number }>; countermodel?: unknown };
  assert.equal(data.valid, true);
  assert.ok(Array.isArray(data.steps), 'steps debe ser array');
  assert.ok(data.steps.length >= 1, `esperaba al menos 1 paso, hay ${data.steps.length}`);
  assert.equal(data.countermodel, undefined, 'derivación válida no debe traer countermodel');
});

test('st_derive: derivación inválida (P ⊢ Q) marca valid=false', async () => {
  const result = await stDerive(call('st_derive', {
    premises: ['P'],
    goal: 'Q'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { valid: boolean };
  assert.equal(data.valid, false);
});

// ── st_countermodel ──────────────────────────────────────────────

test('st_countermodel: P ∧ ¬P devuelve assignments con P presente', async () => {
  const result = await stCountermodel(call('st_countermodel', { formula: 'P & ~P' }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { valid: boolean; assignments: Record<string, boolean | string> };
  assert.equal(data.valid, false);
  assert.ok(typeof data.assignments === 'object' && data.assignments !== null, 'assignments es objeto');
  assert.ok('P' in data.assignments, 'el atom P debe aparecer en assignments');
});

test('st_countermodel: P → P es válida — valid=true, sin assignments', async () => {
  const result = await stCountermodel(call('st_countermodel', { formula: 'P -> P' }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { valid: boolean; assignments?: Record<string, unknown> };
  assert.equal(data.valid, true);
});

// ── st_formalize ─────────────────────────────────────────────────

test('st_formalize: "si llueve entonces el suelo está mojado" → implicación con confianza ≥ 0.5', async () => {
  const result = await stFormalize(call('st_formalize', {
    proseText: 'si llueve entonces el suelo está mojado'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as {
    confidence: number;
    suggestion: string | null;
    detectedConnectives: string[];
  };
  assert.ok(data.confidence >= 0.5, `confidence ${data.confidence} debería ser ≥ 0.5`);
  assert.ok(typeof data.suggestion === 'string' && data.suggestion.length > 0, 'suggestion debe ser string no vacío');
  assert.match(data.suggestion ?? '', /→/, 'la sugerencia debe contener el operador →');
  assert.ok(data.detectedConnectives.includes('implies'), 'debe detectar conectivo "implies"');
});

test('st_formalize: "no llueve" → negación', async () => {
  const result = await stFormalize(call('st_formalize', { proseText: 'no llueve' }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { suggestion: string | null; confidence: number; detectedConnectives: string[] };
  assert.ok(data.confidence >= 0.5);
  assert.match(data.suggestion ?? '', /¬/);
  assert.ok(data.detectedConnectives.includes('not'));
});

test('st_formalize: prosa ambigua sin estructura → suggestion=null con confianza < 0.5', async () => {
  const result = await stFormalize(call('st_formalize', {
    proseText: 'llueve'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { suggestion: string | null; confidence: number };
  assert.equal(data.suggestion, null);
  assert.ok(data.confidence < 0.5);
});

// ── Validación de argumentos ─────────────────────────────────────

test('st_check sin formula falla con mensaje claro', async () => {
  await assert.rejects(
    () => stCheck(call('st_check', {}), ctx),
    /formula es requerido/
  );
});

test('st_derive sin goal falla', async () => {
  await assert.rejects(
    () => stDerive(call('st_derive', { premises: ['P'] }), ctx),
    /goal es requerido/
  );
});

test('st_derive premises debe ser array', async () => {
  await assert.rejects(
    () => stDerive(call('st_derive', { premises: 'P', goal: 'Q' }), ctx),
    /premises es requerido/
  );
});
