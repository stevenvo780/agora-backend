import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackDerive } from '../../../src/lib/agora-ai/feedback-loop/index.ts';
import type {
  LLMCaller,
  Message
} from '../../../src/lib/agora-ai/feedback-loop/index.ts';

// ── helpers ──────────────────────────────────────────────────────

interface RecordedCall {
  prompt: string;
  history: Message[];
}

function makeRecordingCaller(responses: string[]): {
  caller: LLMCaller;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const caller: LLMCaller = async (prompt, history) => {
    calls.push({ prompt, history: [...history] });
    if (i >= responses.length) {
      // Si el loop pide más respuestas que las preparadas, devolvemos basura
      // para que ST rechace y la iteración consuma su slot.
      return '???';
    }
    const r = responses[i] ?? '';
    i += 1;
    return r;
  };
  return { caller, calls };
}

// ── tests ────────────────────────────────────────────────────────

test('feedbackDerive: LLM acierta en iter 1 (modus ponens) → success=true', async () => {
  const { caller, calls } = makeRecordingCaller([
    // Respuesta válida: el LLM devuelve Q como conclusión.
    'Por modus ponens, aplicando P y P → Q obtenemos:\n```st\nQ\n```'
  ]);

  const result = await feedbackDerive(['P', 'P -> Q'], 'Q', {
    llmCaller: caller,
    maxIterations: 3
  });

  assert.equal(result.success, true);
  assert.equal(result.iterations, 1);
  assert.equal(result.finalDerivation, 'Q');
  assert.ok(result.finalProof, 'debe traer finalProof');
  assert.ok(Array.isArray(result.finalProof?.steps), 'finalProof.steps array');
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0]?.stValidation.valid, true);
  assert.equal(calls.length, 1, 'solo se llamó al LLM una vez');
});

test('feedbackDerive: LLM falla en iter 1, corrige en iter 2 → success=true en iter 2', async () => {
  const { caller, calls } = makeRecordingCaller([
    // Iter 1: respuesta sin sentido — no deriva el goal.
    'Hmm, la conclusión es:\n```st\nR\n```',
    // Iter 2: corregida tras ver el contramodelo.
    'Tenés razón, aplicando MP:\n```st\nQ\n```'
  ]);

  const result = await feedbackDerive(['P', 'P -> Q'], 'Q', {
    llmCaller: caller,
    maxIterations: 3
  });

  assert.equal(result.success, true);
  assert.equal(result.iterations, 2);
  assert.equal(result.finalDerivation, 'Q');
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0]?.stValidation.valid, false);
  assert.equal(result.history[1]?.stValidation.valid, true);
  // En el 2do prompt el loop debe haber pasado info del fallo previo.
  assert.equal(calls.length, 2);
  const retryPrompt = calls[1]?.prompt ?? '';
  assert.match(retryPrompt, /no es válida|NO es válida/i, 'el retry prompt debe mencionar fallo');
});

test('feedbackDerive: LLM nunca corrige → success=false en iter maxIterations', async () => {
  const { caller } = makeRecordingCaller([
    '```st\nR\n```',
    '```st\nS\n```',
    '```st\nT\n```'
  ]);

  const result = await feedbackDerive(['P', 'P -> Q'], 'Q', {
    llmCaller: caller,
    maxIterations: 3
  });

  assert.equal(result.success, false);
  assert.equal(result.iterations, 3);
  assert.equal(result.history.length, 3);
  for (const entry of result.history) {
    assert.equal(entry.stValidation.valid, false, `iter ${entry.iter} debe ser inválida`);
  }
  assert.equal(result.finalDerivation, undefined);
});

test('feedbackDerive: goal trivial (tautología) → success=true en iter 1', async () => {
  const { caller, calls } = makeRecordingCaller([
    'Trivialmente:\n```st\nP -> P\n```'
  ]);

  const result = await feedbackDerive([], 'P -> P', {
    llmCaller: caller,
    maxIterations: 3
  });

  assert.equal(result.success, true);
  assert.equal(result.iterations, 1);
  assert.equal(calls.length, 1);
});

test('feedbackDerive: respuesta no parseable se marca como fallo sin crashear', async () => {
  const { caller } = makeRecordingCaller([
    '', // string vacío
    '   \n   \n', // solo whitespace
    'random sin formato'
  ]);

  const result = await feedbackDerive(['P'], 'Q', {
    llmCaller: caller,
    maxIterations: 3
  });

  assert.equal(result.success, false);
  assert.equal(result.iterations, 3);
});

test('feedbackDerive: contramodelo se pasa al LLM en el retry prompt', async () => {
  const { caller, calls } = makeRecordingCaller([
    // Iter 1: el LLM propone algo que es trivialmente inválido.
    '```st\nP & ~P\n```',
    // Iter 2: ya corregido.
    '```st\nP -> P\n```'
  ]);

  const result = await feedbackDerive([], 'P -> P', {
    llmCaller: caller,
    maxIterations: 3
  });

  assert.equal(result.success, true);
  assert.equal(result.iterations, 2);
  // El 2do prompt debería contener el contramodelo del goal o errores ST.
  const retry = calls[1]?.prompt ?? '';
  assert.ok(
    /Contramodelo|Errores|no es válida|NO es válida/i.test(retry),
    `retry prompt debe contener feedback estructurado, fue:\n${retry}`
  );
});

test('feedbackDerive: maxIterations respeta cota inferior (1)', async () => {
  const { caller } = makeRecordingCaller(['```st\nR\n```']);
  const result = await feedbackDerive(['P'], 'Q', {
    llmCaller: caller,
    maxIterations: 1
  });
  assert.equal(result.success, false);
  assert.equal(result.iterations, 1);
});

test('feedbackDerive: sin llmCaller falla con mensaje claro', async () => {
  // @ts-expect-error — verificamos validación de runtime.
  await assert.rejects(() => feedbackDerive(['P'], 'Q', { maxIterations: 3 }), /llmCaller/);
});

test('feedbackDerive: goal vacío falla', async () => {
  const { caller } = makeRecordingCaller(['```st\nQ\n```']);
  await assert.rejects(
    () => feedbackDerive(['P'], '', { llmCaller: caller }),
    /goal/
  );
});

test('feedbackDerive: el history conserva las llmResponse originales', async () => {
  const responses = [
    'wrong:\n```st\nR\n```',
    'right:\n```st\nQ\n```'
  ];
  const { caller } = makeRecordingCaller(responses);

  const result = await feedbackDerive(['P', 'P -> Q'], 'Q', {
    llmCaller: caller,
    maxIterations: 3
  });

  assert.equal(result.success, true);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0]?.llmResponse, responses[0]);
  assert.equal(result.history[1]?.llmResponse, responses[1]);
});

// ── extract.ts ──────────────────────────────────────────────────

import { extractCandidate } from '../../../src/lib/agora-ai/feedback-loop/extract.ts';

test('extractCandidate: bloque ```st``` toma la última línea', () => {
  const r = extractCandidate('blah\n```st\nP\nQ\n```');
  assert.equal(r?.formula, 'Q');
  assert.equal(r?.source, 'fenced');
});

test('extractCandidate: tag <derivation>', () => {
  const r = extractCandidate('texto\n<derivation>\nP -> Q\n</derivation>\n');
  assert.equal(r?.formula, 'P -> Q');
  assert.equal(r?.source, 'tag');
});

test('extractCandidate: texto plano usa la última línea no vacía', () => {
  const r = extractCandidate('reasoning\n\nTherefore: Q');
  assert.equal(r?.formula, 'Q');
  assert.equal(r?.source, 'last-line');
});

test('extractCandidate: vacío → null', () => {
  assert.equal(extractCandidate(''), null);
  assert.equal(extractCandidate('   \n   '), null);
});
