/**
 * Tests del auto-continue de GENERACIÓN: cuando el modelo trunca su propia
 * respuesta por el límite de tokens de salida (finish_reason=length /
 * stop_reason=max_tokens / finishReason=MAX_TOKENS), el adapter debe re-pedir
 * la continuación y concatenar el texto en vez de cortar con "Simplifica".
 *
 * Mockeamos globalThis.fetch para devolver respuestas truncadas controladas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldContinueOutput,
  OUTPUT_CONTINUE_PROMPT,
  type OutputContinueState
} from '../src/lib/agora-ai/autonomy.ts';
import { runProviderConversation } from '../src/lib/agora-ai/providerAdapters.ts';
import type { AgentExecutionContext, ChatMessage } from '../src/lib/agora-ai/types.ts';

test('shouldContinueOutput respeta el cap', () => {
  const state: OutputContinueState = { used: 0 };
  assert.equal(shouldContinueOutput(state, 2), true);
  state.used = 1;
  assert.equal(shouldContinueOutput(state, 2), true);
  state.used = 2;
  assert.equal(shouldContinueOutput(state, 2), false);
  state.used = 3;
  assert.equal(shouldContinueOutput(state, 2), false);
});

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

const installFetchMock = (
  responders: Array<{ status: number; body: unknown }>
): { calls: FetchCall[]; restore: () => void } => {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}'); } catch { /* ignore */ }
    calls.push({ url: typeof url === 'string' ? url : url.toString(), body: parsed });
    const res = responders[Math.min(i, responders.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
};

const baseContext = (): AgentExecutionContext => ({
  workspaceId: 'ws-test',
  uid: 'user-test',
  elapsedBudgetMs: () => 0,
  maxBudgetMs: 600_000
});

const openAIChunk = (content: string, finish: 'length' | 'stop') => ({
  status: 200,
  body: {
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
});

const userMsg = (content: string): ChatMessage[] => [{ role: 'user', content }];

test('OpenAI: trunca por length → continúa y concatena (no muestra "Simplifica")', async () => {
  // Cut mid-word: el modelo retoma a media palabra (sin espacio de borde,
  // que el provider .trim()ea). Así verificamos la concatenación cruda.
  const mock = installFetchMock([
    openAIChunk('Primera parte de la respues', 'length'),
    openAIChunk('ta y la segunda parte final.', 'stop')
  ]);
  try {
    const run = await runProviderConversation({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      messages: userMsg('Escribe algo largo'),
      mode: 'chat',
      executionContext: baseContext(),
      maxOutputContinues: 6
    });
    assert.equal(run.finalReply, 'Primera parte de la respuesta y la segunda parte final.');
    assert.ok(!/Simplifica/.test(run.finalReply), 'no debe pedir simplificar');
    // 2 requests: la original truncada + 1 continuación.
    assert.equal(mock.calls.length, 2);
    // La 2da request inyectó el prompt de continuación como mensaje user.
    const secondMsgs = mock.calls[1]!.body.messages as Array<{ role: string; content: string }>;
    assert.ok(
      secondMsgs.some((m) => m.role === 'user' && m.content === OUTPUT_CONTINUE_PROMPT),
      'la continuación debe inyectar OUTPUT_CONTINUE_PROMPT'
    );
  } finally {
    mock.restore();
  }
});

test('OpenAI: agota el cap de continuaciones → marca truncated y conserva el texto', async () => {
  // Siempre length: nunca termina. Con cap=2 debe parar tras 2 continuaciones.
  const mock = installFetchMock([openAIChunk('chunk', 'length')]);
  try {
    const run = await runProviderConversation({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      messages: userMsg('Escribe infinito'),
      mode: 'chat',
      executionContext: baseContext(),
      maxOutputContinues: 2
    });
    // 1 request inicial + 2 continuaciones = 3.
    assert.equal(mock.calls.length, 3);
    assert.equal(run.truncated, true);
    assert.equal(run.finalReply, 'chunkchunkchunk');
    assert.ok(!/Simplifica/.test(run.finalReply));
  } finally {
    mock.restore();
  }
});

test('OpenAI: cap=0 (deshabilitado) → muestra "Simplifica" en el primer corte', async () => {
  const mock = installFetchMock([openAIChunk('', 'length')]);
  try {
    const run = await runProviderConversation({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      messages: userMsg('x'),
      mode: 'chat',
      executionContext: baseContext(),
      maxOutputContinues: 0
    });
    assert.equal(mock.calls.length, 1);
    assert.equal(run.truncated, true);
    assert.match(run.finalReply, /Simplifica/);
  } finally {
    mock.restore();
  }
});

test('Anthropic: trunca por max_tokens → continúa y concatena', async () => {
  const chunk = (text: string, stop: 'max_tokens' | 'end_turn') => ({
    status: 200,
    body: {
      content: [{ type: 'text', text }],
      stop_reason: stop,
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  });
  const mock = installFetchMock([
    chunk('Parte un', 'max_tokens'),
    chunk('o y parte dos.', 'end_turn')
  ]);
  try {
    const run = await runProviderConversation({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude-haiku-4-5-20251001',
      messages: userMsg('Escribe algo largo'),
      mode: 'chat',
      executionContext: baseContext(),
      maxOutputContinues: 6
    });
    assert.equal(run.finalReply, 'Parte uno y parte dos.');
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('Gemini: trunca por MAX_TOKENS → continúa (antes se perdía silenciosamente)', async () => {
  const chunk = (text: string, finish: 'MAX_TOKENS' | 'STOP') => ({
    status: 200,
    body: {
      candidates: [{ content: { parts: [{ text }] }, finishReason: finish }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    }
  });
  const mock = installFetchMock([
    chunk('Inici', 'MAX_TOKENS'),
    chunk('o y cierre.', 'STOP')
  ]);
  try {
    const run = await runProviderConversation({
      provider: 'gemini',
      apiKey: 'k',
      model: 'gemini-2.0-flash',
      messages: userMsg('Escribe algo largo'),
      mode: 'chat',
      executionContext: baseContext(),
      maxOutputContinues: 6
    });
    assert.equal(run.finalReply, 'Inicio y cierre.');
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test('OpenAI: budget agotado en el corte → no continúa, marca truncated', async () => {
  const mock = installFetchMock([openAIChunk('algo de texto', 'length')]);
  try {
    const ctx = baseContext();
    // elapsed alto: budgetWillExpire() = elapsed + 25s >= max. Forzamos expiración.
    ctx.elapsedBudgetMs = () => 600_000;
    ctx.maxBudgetMs = 600_000;
    const run = await runProviderConversation({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      messages: userMsg('x'),
      mode: 'chat',
      executionContext: ctx,
      maxOutputContinues: 6
    });
    // El budget expira ANTES del primer fetch (chequeo al tope del loop),
    // así que no debe haber requests y el run sale truncado.
    assert.equal(mock.calls.length, 0);
    assert.equal(run.truncated, true);
  } finally {
    mock.restore();
  }
});
