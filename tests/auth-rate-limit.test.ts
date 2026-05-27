/**
 * Tests del rate limit Firestore-backed para endpoints de auth.
 * Usa un factory stub vía `__setAuthRateLimitDocFactoryForTest` para no
 * instanciar firebase-admin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/lib/auth-rate-limit.ts');
const {
  checkAuthRateLimit,
  recordAuthAttempt,
  __setAuthRateLimitDocFactoryForTest,
  __internalsForTest
} = mod;

const store = new Map<string, Record<string, unknown>>();

function applyValue(prev: unknown, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.operand === 'number') {
      return (typeof prev === 'number' ? prev : 0) + v.operand;
    }
    if (typeof v.toMillis === 'function') {
      return (v.toMillis as () => number)();
    }
  }
  return value;
}

__setAuthRateLimitDocFactoryForTest((docId: string) => ({
  async get() {
    const data = store.get(docId);
    return { exists: data !== undefined, data: () => data };
  },
  async set(data: Record<string, unknown>, _options: { merge: boolean }) {
    const prev = store.get(docId) ?? {};
    const next = { ...prev };
    for (const [k, val] of Object.entries(data)) {
      next[k] = applyValue(prev[k], val);
    }
    store.set(docId, next);
    return undefined;
  }
}));

test('bloquea tras maxAttempts dentro de la ventana y devuelve Retry-After', async () => {
  store.clear();
  const key = 'login:1.2.3.4:a@b.com';
  const opts = { windowMs: 15 * 60 * 1000, maxAttempts: 3 };
  const now = 1_000_000;

  for (let i = 0; i < 3; i++) {
    const check = await checkAuthRateLimit(key, opts, now);
    assert.equal(check.ok, true);
    await recordAuthAttempt(key, opts, now);
  }

  const blocked = await checkAuthRateLimit(key, opts, now + 1000);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds > 0);
});

test('reinicia el contador cuando la ventana expira', async () => {
  store.clear();
  const key = 'register:5.6.7.8';
  const opts = { windowMs: 1000, maxAttempts: 2 };

  await recordAuthAttempt(key, opts, 0);
  await recordAuthAttempt(key, opts, 100);
  assert.equal((await checkAuthRateLimit(key, opts, 200)).ok, false);

  // Tras la ventana, el siguiente check pasa y el record reinicia.
  assert.equal((await checkAuthRateLimit(key, opts, 2000)).ok, true);
  await recordAuthAttempt(key, opts, 2000);
  assert.equal((await checkAuthRateLimit(key, opts, 2100)).ok, true);
});

test('fail-open si la lectura de Firestore lanza', async () => {
  __setAuthRateLimitDocFactoryForTest(() => ({
    async get() { throw new Error('firestore down'); },
    async set() { return undefined; }
  }));
  const check = await checkAuthRateLimit('x', { windowMs: 1000, maxAttempts: 1 }, 0);
  assert.deepEqual(check, { ok: true, retryAfterSeconds: 0 });
  __setAuthRateLimitDocFactoryForTest(null);
});

test('safeDocId sanitiza llaves no válidas para Firestore', () => {
  const id = __internalsForTest.safeDocId('login:1.2.3.4:user@example.com');
  assert.ok(!id.includes('/'));
  assert.ok(id.length > 0);
});
