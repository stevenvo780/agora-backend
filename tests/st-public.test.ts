import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEvaluateBody,
  isValidSTProfile,
  handleEvaluate,
  ST_VERSION,
  type STDeps
} from '../src/app/api/public/st/evaluate/route.ts';

import {
  parseCreateKeyBody,
  handleCreateApiKey,
  type AdminKeyDeps
} from '../src/app/api/admin/st-api-keys/route.ts';

import {
  checkRateLimit,
  _resetBuckets
} from '../src/lib/st-rate-limit.ts';

import type { STApiKey } from '../src/lib/st-api-keys.ts';
import type { STEvalResult } from '../src/lib/st-api.ts';

function makeRequest(opts: {
  apiKey?: string;
  body?: unknown;
  adminSecret?: string;
}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.apiKey !== undefined) headers.set('x-st-api-key', opts.apiKey);
  if (opts.adminSecret !== undefined) headers.set('x-backend-internal-secret', opts.adminSecret);
  return new Request('https://example.com/api/public/st/evaluate', {
    method: 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
}

const validKey: STApiKey = {
  hash: 'testhash123',
  owner: 'user@example.com',
  scope: 'public-eval',
  quota: { dailyLimit: 1000, usedToday: 0, resetAt: '2099-01-01T00:00:00.000Z' },
  createdAt: '2026-01-01T00:00:00.000Z'
};

const fakeEvalResult: STEvalResult = {
  ok: true,
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
  results: [],
  diagnostics: []
};

function makeDeps(overrides: Partial<STDeps> = {}): STDeps {
  return {
    lookup: async () => ({ ...validKey }),
    consume: async () => true,
    rateLimit: () => ({ allowed: true }),
    runEval: () => fakeEvalResult,
    ...overrides
  };
}

// ─── parseEvaluateBody ────────────────────────────────────────────────────────

test('parseEvaluateBody: null cuando body no es objeto', () => {
  assert.equal(parseEvaluateBody(null), null);
  assert.equal(parseEvaluateBody('string'), null);
  assert.equal(parseEvaluateBody(42), null);
});

test('parseEvaluateBody: null cuando formula o profile faltan', () => {
  assert.equal(parseEvaluateBody({ formula: 'p' }), null);
  assert.equal(parseEvaluateBody({ profile: 'classical.propositional' }), null);
  assert.equal(parseEvaluateBody({ formula: '', profile: 'classical.propositional' }), null);
  assert.equal(parseEvaluateBody({ formula: 'p', profile: '' }), null);
});

test('parseEvaluateBody: ok con formula y profile presentes', () => {
  const r = parseEvaluateBody({ formula: 'check valid (P → P)', profile: 'classical.propositional' });
  assert.ok(r !== null);
  assert.equal(r.formula, 'check valid (P → P)');
  assert.equal(r.profile, 'classical.propositional');
});

// ─── isValidSTProfile ─────────────────────────────────────────────────────────

test('isValidSTProfile: acepta perfiles conocidos', () => {
  assert.equal(isValidSTProfile('classical.propositional'), true);
  assert.equal(isValidSTProfile('classical.first_order'), true);
  assert.equal(isValidSTProfile('modal.k'), true);
});

test('isValidSTProfile: rechaza perfil desconocido', () => {
  assert.equal(isValidSTProfile('unknown.profile'), false);
  assert.equal(isValidSTProfile(''), false);
});

// ─── rate limit (token bucket) ────────────────────────────────────────────────

test('checkRateLimit: permite primeras 60 req', () => {
  _resetBuckets();
  for (let i = 0; i < 60; i++) {
    assert.equal(checkRateLimit('rl-bucket-test').allowed, true, `fallo en req ${i + 1}`);
  }
});

test('checkRateLimit: bloquea la 61ª req inmediata', () => {
  _resetBuckets();
  for (let i = 0; i < 60; i++) checkRateLimit('rl-block-test');
  const result = checkRateLimit('rl-block-test');
  assert.equal(result.allowed, false);
  assert.ok(typeof result.retryAfterMs === 'number' && result.retryAfterMs > 0, 'debe incluir retryAfterMs > 0');
});

test('checkRateLimit: aísla buckets por keyHash distintos', () => {
  _resetBuckets();
  for (let i = 0; i < 60; i++) checkRateLimit('key-a');
  assert.equal(checkRateLimit('key-a').allowed, false);
  assert.equal(checkRateLimit('key-b').allowed, true);
});

// ─── handleEvaluate ──────────────────────────────────────────────────────────

test('handleEvaluate: 401 sin API key', async () => {
  const req = makeRequest({ body: { formula: 'check valid (P → P)', profile: 'classical.propositional' } });
  const res = await handleEvaluate(req as never, makeDeps());
  assert.equal(res.status, 401);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, 'missing_api_key');
});

test('handleEvaluate: 401 con API key inválida', async () => {
  const req = makeRequest({ apiKey: 'bad-key', body: { formula: 'p', profile: 'classical.propositional' } });
  const deps = makeDeps({ lookup: async () => null });
  const res = await handleEvaluate(req as never, deps);
  assert.equal(res.status, 401);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, 'invalid_api_key');
});

test('handleEvaluate: 429 con quota agotada (usedToday >= dailyLimit)', async () => {
  const exhaustedKey: STApiKey = { ...validKey, quota: { dailyLimit: 10, usedToday: 10, resetAt: '2099-01-01T00:00:00.000Z' } };
  const req = makeRequest({ apiKey: 'somekey', body: { formula: 'p', profile: 'classical.propositional' } });
  const deps = makeDeps({
    lookup: async () => ({ ...exhaustedKey }),
    consume: async () => false
  });
  const res = await handleEvaluate(req as never, deps);
  assert.equal(res.status, 429);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, 'quota_exceeded');
});

test('handleEvaluate: 429 con rate limit excedido + retryAfterMs', async () => {
  const req = makeRequest({ apiKey: 'somekey', body: { formula: 'p', profile: 'classical.propositional' } });
  const deps = makeDeps({
    rateLimit: () => ({ allowed: false, retryAfterMs: 5000 })
  });
  const res = await handleEvaluate(req as never, deps);
  assert.equal(res.status, 429);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, 'rate_limited');
  assert.equal(body.retryAfterMs, 5000);
});

test('handleEvaluate: 200 con API key válida → result + errors + ms + version', async () => {
  const req = makeRequest({
    apiKey: 'valid-key',
    body: { formula: 'check valid (P → P)', profile: 'classical.propositional' }
  });
  const deps = makeDeps();
  const res = await handleEvaluate(req as never, deps);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.ok('result' in body);
  assert.ok('errors' in body);
  assert.ok('ms' in body);
  assert.equal(body.version, ST_VERSION);
});

test('handleEvaluate: CORS headers presentes en respuesta', async () => {
  const req = makeRequest({ apiKey: 'valid-key', body: { formula: 'p', profile: 'classical.propositional' } });
  const res = await handleEvaluate(req as never, makeDeps());
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

// ─── parseCreateKeyBody ───────────────────────────────────────────────────────

test('parseCreateKeyBody: null si falta owner o scope inválido', () => {
  assert.equal(parseCreateKeyBody(null), null);
  assert.equal(parseCreateKeyBody({ scope: 'public-eval' }), null);
  assert.equal(parseCreateKeyBody({ owner: 'user', scope: 'invalid' }), null);
  assert.equal(parseCreateKeyBody({ owner: '', scope: 'public-eval' }), null);
});

test('parseCreateKeyBody: ok con campos mínimos', () => {
  const r = parseCreateKeyBody({ owner: 'user@example.com', scope: 'public-eval' });
  assert.ok(r !== null);
  assert.equal(r.owner, 'user@example.com');
  assert.equal(r.scope, 'public-eval');
  assert.equal(r.dailyLimit, undefined);
});

test('parseCreateKeyBody: acepta dailyLimit numérico válido', () => {
  const r = parseCreateKeyBody({ owner: 'u', scope: 'public-derive', dailyLimit: 500 });
  assert.ok(r !== null);
  assert.equal(r.dailyLimit, 500);
});

test('parseCreateKeyBody: rechaza dailyLimit < 1', () => {
  assert.equal(parseCreateKeyBody({ owner: 'u', scope: 'public-eval', dailyLimit: 0 }), null);
  assert.equal(parseCreateKeyBody({ owner: 'u', scope: 'public-eval', dailyLimit: -5 }), null);
});

// ─── handleCreateApiKey ───────────────────────────────────────────────────────

test('handleCreateApiKey: 401 sin BACKEND_INTERNAL_SECRET', async () => {
  const req = makeRequest({ body: { owner: 'u', scope: 'public-eval' } });
  const deps: AdminKeyDeps = {
    resolveSecret: () => 'real-secret',
    createKey: async () => ({ key: 'k', hash: 'h' })
  };
  const res = await handleCreateApiKey(req as never, deps);
  assert.equal(res.status, 401);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, 'unauthorized');
});

test('handleCreateApiKey: 201 con secret correcto → devuelve key (no hash solo)', async () => {
  const req = makeRequest({
    adminSecret: 'real-secret',
    body: { owner: 'admin@example.com', scope: 'public-eval', dailyLimit: 2000 }
  });
  const deps: AdminKeyDeps = {
    resolveSecret: () => 'real-secret',
    createKey: async (owner, scope, limit) => ({ key: `raw-${owner}-${scope}-${limit ?? 1000}`, hash: 'sha256hash' })
  };
  const res = await handleCreateApiKey(req as never, deps);
  assert.equal(res.status, 201);
  const body = await res.json() as Record<string, unknown>;
  assert.ok(typeof body.key === 'string' && body.key.length > 0, 'debe retornar raw key');
  assert.ok(typeof body.hash === 'string', 'debe retornar hash');
  assert.equal(body.owner, 'admin@example.com');
  assert.equal(body.scope, 'public-eval');
});
