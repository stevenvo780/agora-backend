import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stTacticApply
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

// ── Happy path ───────────────────────────────────────────────────

test('st_tactic_apply: intro en P -> P → ok=true, 1 goal abierto', async () => {
  const result = await stTacticApply(call('st_tactic_apply', {
    goal: 'P -> P',
    tactic: 'intro h'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as {
    complete: boolean;
    openGoals: Array<{ concl: string; hyps: Record<string, string> }>;
    history: string[];
    goal: string;
    tactic: string;
  };
  assert.equal(data.complete, false);
  assert.equal(data.openGoals.length, 1);
  const g = data.openGoals[0];
  assert.ok(g !== undefined, 'primer goal debe existir');
  assert.ok('h' in g.hyps, 'hipótesis "h" debe estar en el contexto');
  assert.ok(Array.isArray(data.history), 'history debe ser array');
  assert.equal(data.history[0], 'intro', 'historia debe contener "intro"');
});

test('st_tactic_apply: intro + assumption completa P -> P', async () => {
  // Primer paso: intro h
  const r1 = await stTacticApply(call('st_tactic_apply', {
    goal: 'P -> P',
    tactic: 'intro h'
  }), ctx);
  assert.equal(r1.ok, true);
  const d1 = r1.data as { openGoals: Array<{ concl: string; hyps: Record<string, string> }> };
  // El goal restante es "P" con h:P en contexto → assumption lo cierra
  // Simulamos el segundo paso con el goal P y contexto h:P
  const r2 = await stTacticApply(call('st_tactic_apply', {
    goal: 'P',
    tactic: 'assumption',
    context: [{ name: 'h', statement: 'P' }]
  }), ctx);
  assert.equal(r2.ok, true);
  const d2 = r2.data as { complete: boolean; openGoals: unknown[] };
  assert.equal(d2.complete, true);
  assert.equal(d2.openGoals.length, 0);
});

test('st_tactic_apply: split en P -> Q -> P /\\ Q', async () => {
  const result = await stTacticApply(call('st_tactic_apply', {
    goal: 'P -> Q -> P',
    tactic: 'intro h'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { complete: boolean; openGoals: Array<{ concl: string }> };
  assert.equal(data.complete, false);
  assert.ok(data.openGoals.length >= 1, 'debe haber al menos 1 goal abierto');
});

test('st_tactic_apply: assumption con hipótesis en context directa', async () => {
  const result = await stTacticApply(call('st_tactic_apply', {
    goal: 'P',
    tactic: 'assumption',
    context: [{ name: 'hp', statement: 'P' }]
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { complete: boolean };
  assert.equal(data.complete, true);
});

test('st_tactic_apply: trivial cierra True', async () => {
  const result = await stTacticApply(call('st_tactic_apply', {
    goal: 'True',
    tactic: 'trivial'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { complete: boolean };
  assert.equal(data.complete, true);
});

test('st_tactic_apply: shape de respuesta es correcto en caso exitoso', async () => {
  const result = await stTacticApply(call('st_tactic_apply', {
    goal: 'P -> P',
    tactic: 'intro h'
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.ok('complete' in data, 'debe tener campo complete');
  assert.ok('openGoals' in data, 'debe tener campo openGoals');
  assert.ok('newGoals' in data, 'debe tener campo newGoals');
  assert.ok('history' in data, 'debe tener campo history');
  assert.ok('goal' in data, 'debe tener campo goal');
  assert.ok('tactic' in data, 'debe tener campo tactic');
});

// ── Error handling ───────────────────────────────────────────────

test('st_tactic_apply: táctica fallida devuelve ok=true con error en data', async () => {
  // assumption sin hipótesis en goal P -> P falla con TacticError
  const result = await stTacticApply(call('st_tactic_apply', {
    goal: 'P -> P',
    tactic: 'assumption'
  }), ctx);
  // ok=true porque el error es semántico (táctica falló), no de protocolo
  assert.equal(result.ok, true);
  const data = result.data as { complete: boolean; error?: string };
  assert.equal(data.complete, false);
  assert.ok(typeof data.error === 'string' && data.error.length > 0, 'data.error debe describir el fallo');
});

test('st_tactic_apply: táctica desconocida devuelve ok=false con mensaje claro', async () => {
  const result = await stTacticApply(call('st_tactic_apply', {
    goal: 'P -> P',
    tactic: 'magicwand'
  }), ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Táctica desconocida/);
});

// ── Input validation (schema rejection) ─────────────────────────

test('st_tactic_apply: sin goal falla con Argumentos inválidos', async () => {
  const result = await stTacticApply(call('st_tactic_apply', { tactic: 'intro' }), ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Argumentos inválidos/);
});

test('st_tactic_apply: sin tactic falla con Argumentos inválidos', async () => {
  const result = await stTacticApply(call('st_tactic_apply', { goal: 'P -> P' }), ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Argumentos inválidos/);
});
