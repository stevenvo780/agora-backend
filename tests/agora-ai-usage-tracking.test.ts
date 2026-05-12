/**
 * Tests del módulo `usageTracking` (cap diario, cap horario, abuso 429).
 *
 * Los caps in-memory (hourly, abuse) se prueban directamente.
 * El cap diario (Firestore) se prueba con un factory stub vía
 * `__setUsageDocFactoryForTest` — así no instanciamos firebase-admin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Caps reducidos para que los tests sean rápidos y deterministas.
process.env.AGORA_AI_DAILY_TOKEN_BUDGET = '1000';
process.env.AGORA_AI_HOURLY_MESSAGE_CAP = '5';

const mod = await import('../src/lib/agora-ai/usageTracking.ts');
const {
  checkDailyBudget,
  recordUsage,
  checkHourlyMessageCap,
  incrementMessageCount,
  checkAbuseBlock,
  recordAbuseSignal,
  __resetUsageTrackingMemory,
  __setUsageDocFactoryForTest,
  __constantsForTest,
  __internalsForTest
} = mod;

// ---- Fake Firestore doc store --------------------------------------------
//
// Acepta dos formas de "increment":
//  - sentinel real de firebase-admin v13 (objeto con `operand: number`)
//  - shape sintético { __op:'increment', value } para tests directos
// Cualquier otro valor numérico se asigna tal cual.

const fakeStore = new Map<string, Record<string, unknown>>();

function applyMaybeIncrement(prev: unknown, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.operand === 'number') {
      const base = typeof prev === 'number' ? prev : 0;
      return base + v.operand;
    }
    if (v.__op === 'increment') {
      const base = typeof prev === 'number' ? prev : 0;
      return base + Number(v.value || 0);
    }
  }
  return value;
}

function fakeFactory(uid: string, day: string) {
  const key = `${uid}::${day}`;
  return {
    async get() {
      const data = fakeStore.get(key);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>, _options: { merge: boolean }) {
      const prev = fakeStore.get(key) ?? {};
      const next: Record<string, unknown> = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        if (k === 'promptTokens' || k === 'completionTokens' || k === 'requestCount') {
          next[k] = applyMaybeIncrement(prev[k], v);
        } else {
          next[k] = v;
        }
      }
      fakeStore.set(key, next);
      return undefined;
    }
  };
}

function resetAll() {
  fakeStore.clear();
  __resetUsageTrackingMemory();
  __setUsageDocFactoryForTest(fakeFactory);
}

// ---- Tests ----------------------------------------------------------------

test('cap diario: user dentro del budget → ok', async () => {
  resetAll();
  const r = await checkDailyBudget('user-A');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.budget, 1000);
    assert.equal(r.used, 0);
  }
});

test('cap diario: recordUsage suma y bloquea al exceder budget', async () => {
  resetAll();
  await recordUsage('user-B', 600, 300); // 900
  const mid = await checkDailyBudget('user-B');
  assert.equal(mid.ok, true, 'aún por debajo de 1000');
  await recordUsage('user-B', 100, 50); // 1050 ≥ 1000
  const after = await checkDailyBudget('user-B');
  assert.equal(after.ok, false);
  if (!after.ok) {
    assert.equal(after.reason, 'daily-token-budget');
    assert.ok(after.retryAfterMs > 0, 'retryAfterMs hasta medianoche UTC > 0');
    assert.ok(after.retryAfterMs <= 24 * 60 * 60 * 1000);
    assert.equal(after.budget, 1000);
    assert.ok(after.used >= 1000);
  }
});

test('cap diario: aislamiento por uid', async () => {
  resetAll();
  await recordUsage('user-C', 2000, 0);
  const me = await checkDailyBudget('user-C');
  const other = await checkDailyBudget('user-D');
  assert.equal(me.ok, false);
  assert.equal(other.ok, true);
});

test('cap horario: user excediendo mensajes/hora → 429', () => {
  resetAll();
  for (let i = 0; i < 5; i++) {
    const ok = checkHourlyMessageCap('user-E');
    assert.equal(ok.ok, true, `iter ${i} debería pasar`);
    incrementMessageCount('user-E');
  }
  const blocked = checkHourlyMessageCap('user-E');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.reason, 'hourly-message-cap');
    assert.equal(blocked.cap, 5);
    assert.ok(blocked.retryAfterMs >= 0);
  }
});

test('cap horario: aislamiento por uid', () => {
  resetAll();
  for (let i = 0; i < 5; i++) incrementMessageCount('user-F');
  assert.equal(checkHourlyMessageCap('user-F').ok, false);
  assert.equal(checkHourlyMessageCap('user-G').ok, true);
});

test('abuse-block: 5×429 en ventana → bloqueado 10min', () => {
  resetAll();
  for (let i = 0; i < 4; i++) {
    const r = recordAbuseSignal('user-H');
    assert.equal(r.blocked, false, `tras ${i + 1} señales NO debería estar bloqueado aún`);
  }
  const fifth = recordAbuseSignal('user-H');
  assert.equal(fifth.blocked, true, '5ta señal dispara bloqueo');
  const check = checkAbuseBlock('user-H');
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.equal(check.reason, 'abuse-block');
    assert.ok(check.retryAfterMs > 0);
    assert.ok(check.retryAfterMs <= __constantsForTest.TEN_MIN_MS);
  }
});

test('abuse-block: user limpio pasa sin restricciones', () => {
  resetAll();
  const r = checkAbuseBlock('user-I');
  assert.equal(r.ok, true);
});

test('abuse-block: señales antiguas (>10min) no cuentan', () => {
  resetAll();
  const now = Date.now();
  const old = now - __constantsForTest.TEN_MIN_MS - 60_000;
  for (let i = 0; i < 4; i++) recordAbuseSignal('user-J', old);
  // Una señal nueva no debería bloquear porque las 4 viejas ya expiraron.
  const fresh = recordAbuseSignal('user-J', now);
  assert.equal(fresh.blocked, false, 'señales viejas se purgan');
});

test('recordUsage: pt=0 y ct=0 → no escribe (no-op)', async () => {
  resetAll();
  await recordUsage('user-K', 0, 0);
  const r = await checkDailyBudget('user-K');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.used, 0);
});

test('recordUsage: negativos se sanean a 0', async () => {
  resetAll();
  await recordUsage('user-L', -100, -50);
  const r = await checkDailyBudget('user-L');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.used, 0);
});

test('helper interno msUntilMidnightUtc: rango sensato', () => {
  const now = Date.UTC(2026, 4, 12, 23, 0, 0); // 23:00 UTC
  const ms = __internalsForTest.msUntilMidnightUtc(now);
  assert.equal(ms, 60 * 60 * 1000, 'desde 23:00 UTC quedan 60min al reset');
});

test('helper interno dayKey: ISO YYYY-MM-DD UTC', () => {
  const key = __internalsForTest.dayKey(Date.UTC(2026, 4, 12, 23, 0, 0));
  assert.equal(key, '2026-05-12');
});

test('config: constantes exportadas con defaults sensatos', () => {
  assert.equal(__constantsForTest.DEFAULT_DAILY_TOKEN_BUDGET, 100_000);
  assert.equal(__constantsForTest.DEFAULT_HOURLY_MESSAGE_CAP, 100);
  assert.equal(__constantsForTest.ABUSE_THRESHOLD_429, 5);
  assert.equal(__constantsForTest.TEN_MIN_MS, 10 * 60 * 1000);
});
