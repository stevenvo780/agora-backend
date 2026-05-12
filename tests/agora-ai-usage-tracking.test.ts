/**
 * Tests del módulo `usageTracking` (cap diario por proveedor, cap horario,
 * abuso 429).
 *
 * Los caps in-memory (hourly, abuse) se prueban directamente.
 * El cap diario (Firestore) se prueba con un factory stub vía
 * `__setUsageDocFactoryForTest` — así no instanciamos firebase-admin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Budgets por proveedor reducidos para tests rápidos y deterministas.
process.env.AGORA_AI_BUDGET_DEEPSEEK = '2000';
process.env.AGORA_AI_BUDGET_OPENAI = '500';
process.env.AGORA_AI_BUDGET_ANTHROPIC = '500';
process.env.AGORA_AI_BUDGET_GOOGLE = '800';
process.env.AGORA_AI_BUDGET_CUSTOM = '300';
process.env.AGORA_AI_DAILY_TOKEN_BUDGET = '1000'; // fallback global
process.env.AGORA_AI_HOURLY_MESSAGE_CAP = '5';

const mod = await import('../src/lib/agora-ai/usageTracking.ts');
const {
  checkDailyBudget,
  recordUsage,
  checkHourlyMessageCap,
  incrementMessageCount,
  checkAbuseBlock,
  recordAbuseSignal,
  normalizeProvider,
  resolveBudgetFor,
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
//
// Soporta también dotted paths (`byProvider.deepseek.promptTokens`) que es
// como Firestore actualiza sub-fields anidados al hacer set con merge.

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

function setDotted(target: Record<string, unknown>, path: string[], value: unknown): void {
  // Navega creando objetos intermedios y aplica increment en la hoja si aplica.
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (!next || typeof next !== 'object') {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1]!;
  cur[leaf] = applyMaybeIncrement(cur[leaf], value);
}

function fakeFactory(uid: string, day: string) {
  const key = `${uid}::${day}`;
  return {
    async get() {
      const data = fakeStore.get(key);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>, _options: { merge: boolean }) {
      const next: Record<string, unknown> = { ...(fakeStore.get(key) ?? {}) };
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) {
          setDotted(next, k.split('.'), v);
        } else if (k === 'promptTokens' || k === 'completionTokens' || k === 'requestCount') {
          next[k] = applyMaybeIncrement(next[k], v);
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

// ---- Tests: normalización de proveedor -----------------------------------

test('normalizeProvider: mapea aliases conocidos', () => {
  assert.equal(normalizeProvider('deepseek'), 'deepseek');
  assert.equal(normalizeProvider('OpenAI'), 'openai');
  assert.equal(normalizeProvider('anthropic'), 'anthropic');
  assert.equal(normalizeProvider('google'), 'google');
  assert.equal(normalizeProvider('gemini'), 'google');
  assert.equal(normalizeProvider('agora-gateway'), 'custom');
  assert.equal(normalizeProvider('custom'), 'custom');
});

test('normalizeProvider: provider desconocido → null', () => {
  assert.equal(normalizeProvider('ollama'), null);
  assert.equal(normalizeProvider('xyz'), null);
  assert.equal(normalizeProvider(''), null);
  assert.equal(normalizeProvider(null), null);
  assert.equal(normalizeProvider(undefined), null);
});

test('resolveBudgetFor: aplica env del proveedor', () => {
  assert.deepEqual(resolveBudgetFor('deepseek'), { budget: 2000, providerKey: 'deepseek' });
  assert.deepEqual(resolveBudgetFor('openai'), { budget: 500, providerKey: 'openai' });
  assert.deepEqual(resolveBudgetFor('gemini'), { budget: 800, providerKey: 'google' });
  assert.deepEqual(resolveBudgetFor('custom'), { budget: 300, providerKey: 'custom' });
});

test('resolveBudgetFor: provider desconocido → fallback global', () => {
  assert.deepEqual(resolveBudgetFor('ollama'), { budget: 1000, providerKey: null });
  assert.deepEqual(resolveBudgetFor(undefined), { budget: 1000, providerKey: null });
});

// ---- Tests: cap diario por proveedor -------------------------------------

test('cap diario: user DeepSeek dentro del budget DeepSeek → ok', async () => {
  resetAll();
  await recordUsage('user-A', 'deepseek', 1500, 0); // 1500 < 2000
  const r = await checkDailyBudget('user-A', 'deepseek');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.budget, 2000);
    assert.equal(r.used, 1500);
    assert.equal(r.provider, 'deepseek');
  }
});

test('cap diario: user OpenAI dentro del budget OpenAI → ok', async () => {
  resetAll();
  await recordUsage('user-B', 'openai', 400, 50); // 450 < 500
  const r = await checkDailyBudget('user-B', 'openai');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.budget, 500);
    assert.equal(r.used, 450);
    assert.equal(r.provider, 'openai');
  }
});

test('cap diario: DeepSeek excede su propio cap → 429 con provider=deepseek', async () => {
  resetAll();
  await recordUsage('user-C', 'deepseek', 1500, 500); // 2000 ≥ 2000
  const r = await checkDailyBudget('user-C', 'deepseek');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'daily-token-budget');
    assert.equal(r.provider, 'deepseek');
    assert.equal(r.budget, 2000);
    assert.ok(r.used >= 2000);
    assert.ok(r.retryAfterMs > 0);
  }
});

test('cap diario: aislamiento entre proveedores del mismo user', async () => {
  resetAll();
  // User excede DeepSeek pero NO ha tocado OpenAI.
  await recordUsage('user-D', 'deepseek', 2100, 0);
  const ds = await checkDailyBudget('user-D', 'deepseek');
  const op = await checkDailyBudget('user-D', 'openai');
  assert.equal(ds.ok, false, 'DeepSeek excedido');
  assert.equal(op.ok, true, 'OpenAI sigue limpio (caps independientes)');
  if (op.ok) {
    assert.equal(op.used, 0);
    assert.equal(op.budget, 500);
  }
});

test('cap diario: provider unknown usa fallback global', async () => {
  resetAll();
  // Consumimos contra "ollama" → no toca byProvider, sólo totales globales.
  await recordUsage('user-E', 'ollama', 600, 500); // total 1100 ≥ 1000 fallback
  const r = await checkDailyBudget('user-E', 'ollama');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.provider, null, 'provider null porque no matchea key canónico');
    assert.equal(r.budget, 1000);
    assert.ok(r.used >= 1000);
  }
});

test('cap diario: aislamiento por uid', async () => {
  resetAll();
  await recordUsage('user-F', 'deepseek', 2100, 0);
  const me = await checkDailyBudget('user-F', 'deepseek');
  const other = await checkDailyBudget('user-G', 'deepseek');
  assert.equal(me.ok, false);
  assert.equal(other.ok, true);
});

test('cap diario: gemini se normaliza a google (mismo budget)', async () => {
  resetAll();
  await recordUsage('user-H', 'gemini', 400, 0); // bucket google
  const checkGemini = await checkDailyBudget('user-H', 'gemini');
  const checkGoogle = await checkDailyBudget('user-H', 'google');
  if (checkGemini.ok && checkGoogle.ok) {
    assert.equal(checkGemini.used, 400);
    assert.equal(checkGoogle.used, 400, 'gemini y google leen el mismo bucket');
    assert.equal(checkGemini.budget, 800);
  } else {
    assert.fail('ambos deberían pasar (400 < 800)');
  }
});

// ---- Tests: migración de docs viejos -------------------------------------

test('migración: doc viejo sin byProvider no rompe checkDailyBudget', async () => {
  resetAll();
  // Simulamos un doc preexistente del schema antiguo (totales globales únicamente).
  fakeStore.set(`user-OLD::${__internalsForTest.dayKey(Date.now())}`, {
    promptTokens: 500,
    completionTokens: 300,
    requestCount: 3,
    lastResetAt: __internalsForTest.dayKey(Date.now())
    // No byProvider field.
  });
  // Check contra DeepSeek: como no hay byProvider.deepseek, used=0 → pasa.
  const ds = await checkDailyBudget('user-OLD', 'deepseek');
  assert.equal(ds.ok, true);
  if (ds.ok) assert.equal(ds.used, 0, 'doc viejo → counter por-provider arranca en 0');
});

test('migración: recordUsage post-deploy escribe byProvider sin romper totales', async () => {
  resetAll();
  const day = __internalsForTest.dayKey(Date.now());
  fakeStore.set(`user-MIGR::${day}`, {
    promptTokens: 100,
    completionTokens: 50,
    requestCount: 1,
    lastResetAt: day
  });
  await recordUsage('user-MIGR', 'deepseek', 200, 100);
  const doc = fakeStore.get(`user-MIGR::${day}`)!;
  assert.equal(doc.promptTokens, 300, 'totales globales acumulan');
  assert.equal(doc.completionTokens, 150);
  const byProvider = doc.byProvider as Record<string, Record<string, number>>;
  assert.equal(byProvider.deepseek!.promptTokens, 200);
  assert.equal(byProvider.deepseek!.completionTokens, 100);
});

test('migración: doc viejo + fallback global sigue funcionando', async () => {
  resetAll();
  const day = __internalsForTest.dayKey(Date.now());
  // Doc viejo con 1200 tokens totales — supera fallback (1000) pero NO toca caps de provider.
  fakeStore.set(`user-OLD2::${day}`, {
    promptTokens: 800,
    completionTokens: 400,
    requestCount: 2,
    lastResetAt: day
  });
  // Provider desconocido → fallback: 1200 ≥ 1000 → bloqueado.
  const fallback = await checkDailyBudget('user-OLD2', 'ollama');
  assert.equal(fallback.ok, false);
  // Provider conocido → byProvider.openai vacío → pasa.
  const openai = await checkDailyBudget('user-OLD2', 'openai');
  assert.equal(openai.ok, true);
});

// ---- Tests: cap horario y abuse-block (sin cambios funcionales) ----------

test('cap horario: user excediendo mensajes/hora → 429', () => {
  resetAll();
  for (let i = 0; i < 5; i++) {
    const ok = checkHourlyMessageCap('user-I');
    assert.equal(ok.ok, true, `iter ${i} debería pasar`);
    incrementMessageCount('user-I');
  }
  const blocked = checkHourlyMessageCap('user-I');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.reason, 'hourly-message-cap');
    assert.equal(blocked.cap, 5);
    assert.ok(blocked.retryAfterMs >= 0);
  }
});

test('cap horario: aislamiento por uid', () => {
  resetAll();
  for (let i = 0; i < 5; i++) incrementMessageCount('user-J');
  assert.equal(checkHourlyMessageCap('user-J').ok, false);
  assert.equal(checkHourlyMessageCap('user-K').ok, true);
});

test('abuse-block: 5×429 en ventana → bloqueado 10min', () => {
  resetAll();
  for (let i = 0; i < 4; i++) {
    const r = recordAbuseSignal('user-L');
    assert.equal(r.blocked, false, `tras ${i + 1} señales NO debería estar bloqueado aún`);
  }
  const fifth = recordAbuseSignal('user-L');
  assert.equal(fifth.blocked, true, '5ta señal dispara bloqueo');
  const check = checkAbuseBlock('user-L');
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.equal(check.reason, 'abuse-block');
    assert.ok(check.retryAfterMs > 0);
    assert.ok(check.retryAfterMs <= __constantsForTest.TEN_MIN_MS);
  }
});

test('abuse-block: user limpio pasa sin restricciones', () => {
  resetAll();
  const r = checkAbuseBlock('user-M');
  assert.equal(r.ok, true);
});

test('abuse-block: señales antiguas (>10min) no cuentan', () => {
  resetAll();
  const now = Date.now();
  const old = now - __constantsForTest.TEN_MIN_MS - 60_000;
  for (let i = 0; i < 4; i++) recordAbuseSignal('user-N', old);
  const fresh = recordAbuseSignal('user-N', now);
  assert.equal(fresh.blocked, false, 'señales viejas se purgan');
});

// ---- Tests: edge cases recordUsage --------------------------------------

test('recordUsage: pt=0 y ct=0 → no escribe (no-op)', async () => {
  resetAll();
  await recordUsage('user-O', 'deepseek', 0, 0);
  const r = await checkDailyBudget('user-O', 'deepseek');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.used, 0);
});

test('recordUsage: negativos se sanean a 0', async () => {
  resetAll();
  await recordUsage('user-P', 'deepseek', -100, -50);
  const r = await checkDailyBudget('user-P', 'deepseek');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.used, 0);
});

test('recordUsage: provider null/undefined sólo actualiza totales', async () => {
  resetAll();
  const day = __internalsForTest.dayKey(Date.now());
  await recordUsage('user-Q', null, 100, 50);
  const doc = fakeStore.get(`user-Q::${day}`)!;
  assert.equal(doc.promptTokens, 100);
  assert.equal(doc.completionTokens, 50);
  assert.equal(doc.byProvider, undefined, 'no se crea byProvider con provider null');
});

// ---- Tests: helpers internos --------------------------------------------

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
  assert.equal(__constantsForTest.DEFAULT_BUDGETS.deepseek, 2_000_000);
  assert.equal(__constantsForTest.DEFAULT_BUDGETS.openai, 200_000);
  assert.equal(__constantsForTest.DEFAULT_BUDGETS.anthropic, 200_000);
  assert.equal(__constantsForTest.DEFAULT_BUDGETS.google, 500_000);
  assert.equal(__constantsForTest.DEFAULT_BUDGETS.custom, 100_000);
  assert.equal(__constantsForTest.DEFAULT_FALLBACK_BUDGET, 1_000_000);
  assert.equal(__constantsForTest.DEFAULT_HOURLY_MESSAGE_CAP, 100);
  assert.equal(__constantsForTest.ABUSE_THRESHOLD_429, 5);
  assert.equal(__constantsForTest.TEN_MIN_MS, 10 * 60 * 1000);
});
