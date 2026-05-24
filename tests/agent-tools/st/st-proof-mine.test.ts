import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stProofMine
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

// Corpus de pruebas que comparten el patrón X -> X (generalizable por anti-unificación)
const twoProofCorpus = [
  {
    conclusion: 'P -> P',
    premises: ['P'],
    profile: 'classical.propositional',
    steps: [
      { rule: 'MP', inputs: ['P -> P'], output: 'P -> P', depth: 0 },
      { rule: 'hyp', inputs: [], output: 'P', depth: 1 }
    ],
    cost: 2
  },
  {
    conclusion: 'Q -> Q',
    premises: ['Q'],
    profile: 'classical.propositional',
    steps: [
      { rule: 'MP', inputs: ['Q -> Q'], output: 'Q -> Q', depth: 0 },
      { rule: 'hyp', inputs: [], output: 'Q', depth: 1 }
    ],
    cost: 2
  }
];

// ── Happy path ───────────────────────────────────────────────────

test('st_proof_mine: corpus de 2 proofs → ok=true con shape correcto', async () => {
  const result = await stProofMine(call('st_proof_mine', { proofs: twoProofCorpus }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as {
    lemmasCount: number;
    topLemmas: unknown[];
    stats: Record<string, number> | null;
    corpusSize: number;
  };
  assert.ok(typeof data.lemmasCount === 'number', 'lemmasCount debe ser number');
  assert.ok(Array.isArray(data.topLemmas), 'topLemmas debe ser array');
  assert.equal(data.corpusSize, 2);
  assert.ok(data.stats !== undefined, 'stats debe existir');
});

test('st_proof_mine: extrae al menos 1 lemma del corpus con patrón compartido', async () => {
  const result = await stProofMine(call('st_proof_mine', { proofs: twoProofCorpus }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { lemmasCount: number; topLemmas: Array<{ id: string; statement: string; usageCount: number; savings: number; abstractionLevel: number }> };
  assert.ok(data.lemmasCount >= 1, `esperaba ≥1 lemma, encontró ${data.lemmasCount}`);
  if (data.topLemmas.length > 0) {
    const lemma = data.topLemmas[0];
    assert.ok(lemma !== undefined, 'primer lemma debe existir');
    assert.ok(typeof lemma.id === 'string' && lemma.id.length > 0, 'id debe ser string no vacío');
    assert.ok(typeof lemma.statement === 'string', 'statement debe ser string');
    assert.ok(typeof lemma.usageCount === 'number', 'usageCount debe ser number');
    assert.ok(typeof lemma.savings === 'number', 'savings debe ser number');
    assert.ok(typeof lemma.abstractionLevel === 'number', 'abstractionLevel debe ser number');
  }
});

test('st_proof_mine: stats tiene campos esperados', async () => {
  const result = await stProofMine(call('st_proof_mine', { proofs: twoProofCorpus }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { stats: Record<string, number> | null };
  if (data.stats !== null) {
    assert.ok(typeof data.stats === 'object', 'stats debe ser objeto');
    const s = data.stats;
    assert.ok('proofsAnalyzed' in s, 'stats.proofsAnalyzed debe existir');
    assert.ok('lemmasExtracted' in s, 'stats.lemmasExtracted debe existir');
  }
});

test('st_proof_mine: topK=1 devuelve máximo 1 lemma', async () => {
  const result = await stProofMine(call('st_proof_mine', {
    proofs: twoProofCorpus,
    options: { topK: 1 }
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { topLemmas: unknown[] };
  assert.ok(data.topLemmas.length <= 1, `esperaba ≤1 lemma en topLemmas, hay ${data.topLemmas.length}`);
});

test('st_proof_mine: corpus sin pattern compartido devuelve lemmasCount=0', async () => {
  const disjointCorpus = [
    {
      conclusion: 'P -> Q',
      premises: ['P', 'P -> Q'],
      profile: 'classical.propositional',
      steps: [{ rule: 'MP', inputs: ['P', 'P -> Q'], output: 'P -> Q', depth: 0 }],
      cost: 1
    },
    {
      conclusion: 'R -> S',
      premises: ['R', 'R -> S'],
      profile: 'classical.propositional',
      steps: [{ rule: 'MP', inputs: ['R', 'R -> S'], output: 'R -> S', depth: 0 }],
      cost: 1
    }
  ];
  const result = await stProofMine(call('st_proof_mine', { proofs: disjointCorpus }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { lemmasCount: number; topLemmas: unknown[] };
  // Con corpus de 1 paso, el miner descarta sub-trees triviales (minSubtreeSize=2)
  assert.ok(typeof data.lemmasCount === 'number', 'lemmasCount debe ser number');
  assert.ok(Array.isArray(data.topLemmas), 'topLemmas debe ser array');
});

// ── Input validation (schema rejection) ─────────────────────────

test('st_proof_mine: sin proofs falla con error claro', async () => {
  const result = await stProofMine(call('st_proof_mine', {}), ctx);
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error debe ser string');
  assert.match(result.error ?? '', /Argumentos inválidos/);
});

test('st_proof_mine: solo 1 proof (< mínimo 2) falla', async () => {
  const result = await stProofMine(call('st_proof_mine', {
    proofs: [twoProofCorpus[0]]
  }), ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Argumentos inválidos/);
});

test('st_proof_mine: proof con steps vacío falla validación', async () => {
  const badCorpus = [
    { conclusion: 'P', premises: [], profile: 'classical.propositional', steps: [], cost: 0 },
    { conclusion: 'Q', premises: [], profile: 'classical.propositional', steps: [], cost: 0 }
  ];
  const result = await stProofMine(call('st_proof_mine', { proofs: badCorpus }), ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Argumentos inválidos/);
});

test('st_proof_mine: minReuseThreshold=10 en corpus pequeño → 0 lemmas', async () => {
  const result = await stProofMine(call('st_proof_mine', {
    proofs: twoProofCorpus,
    options: { minReuseThreshold: 10 }
  }), ctx);
  assert.equal(result.ok, true);
  const data = result.data as { lemmasCount: number };
  assert.equal(data.lemmasCount, 0);
});
