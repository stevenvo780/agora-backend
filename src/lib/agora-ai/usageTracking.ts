/**
 * Rate limiting fino + abuse prevention para el agente IA.
 *
 * Capas:
 *  1. Cap diario de tokens por user **y por proveedor** (Firestore, persiste
 *     cross-instance). Cada proveedor tiene su propio budget configurable —
 *     justicia: DeepSeek (~$0.14/MTok) tolera caps mucho mayores que GPT-4o
 *     (~$2.50/MTok) sin romper la economía.
 *  2. Cap horario de mensajes por user (in-memory, sliding window).
 *  3. Bloqueo automático si user acumula N×429 en ventana corta.
 *  4. Señal estructurada de abuso (Cloud Logging — log-based metric futura).
 *
 * Firestore schema (v2, con `byProvider`):
 *   users/{uid}/agentUsage/daily-{YYYY-MM-DD}
 *     {
 *       promptTokens, completionTokens, requestCount,         // totales agregados
 *       byProvider: {
 *         deepseek: { promptTokens, completionTokens },
 *         openai:   { promptTokens, completionTokens },
 *         anthropic:{ promptTokens, completionTokens },
 *         google:   { promptTokens, completionTokens },
 *         custom:   { promptTokens, completionTokens },
 *       },
 *       lastResetAt, expiresAt
 *     }
 *
 * Migración: los docs viejos (sin `byProvider`) se tratan como si todos los
 * sub-contadores fueran 0. El primer call post-deploy escribe `byProvider`;
 * los totales globales siguen sumando sin interrupción. No requiere backfill.
 *
 *   `expiresAt` (Timestamp) habilita TTL automático de Firestore: docs >7d
 *   se borran sin job manual. El TTL se configura en consola sobre el field
 *   `expiresAt` de la colección `agentUsage` (group-collection TTL).
 *
 * Multi-instance caveat: el cap horario y el blocklist viven en memoria del
 * proceso. En Cloud Run con N>1 instancias el límite efectivo escala con N,
 * cosa aceptable como freno suave; el cap *duro* es el diario en Firestore.
 */
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

// Identificadores canónicos de proveedor para el budget. `gemini` se
// normaliza a `google` para alinear con la nomenclatura de billing.
export const BUDGET_PROVIDER_KEYS = ['deepseek', 'openai', 'anthropic', 'google', 'custom'] as const;
export type BudgetProviderKey = typeof BUDGET_PROVIDER_KEYS[number];

const PROVIDER_ALIASES: Record<string, BudgetProviderKey> = {
  deepseek: 'deepseek',
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  custom: 'custom',
  'agora-gateway': 'custom'
};

/**
 * Normaliza un identificador de proveedor (de cualquier origen: body, modelo,
 * AgentSecretProvider, etc.) al key canónico de budget. Si no matchea,
 * devuelve `null` y el caller debe usar el fallback global.
 */
export function normalizeProvider(provider: string | null | undefined): BudgetProviderKey | null {
  if (!provider) return null;
  const key = provider.toLowerCase().trim();
  return PROVIDER_ALIASES[key] ?? null;
}

// Thresholds generosos para sesiones QA y usuarios power (2026-05-13).
// El cap diario sigue intacto; solo ampliamos la ventana de tokens/minuto y
// la tolerancia de 429 antes del abuse-block (10 min) para evitar bloqueos
// en sesiones legítimas con prompts largos.
const DEFAULT_BUDGETS: Record<BudgetProviderKey, number> = {
  deepseek: 2_000_000,
  openai: 500_000,   // era 200_000
  anthropic: 500_000, // era 200_000
  google: 500_000,
  custom: 300_000    // era 100_000
};
const DEFAULT_FALLBACK_BUDGET = 1_000_000;
const DEFAULT_HOURLY_MESSAGE_CAP = 100;
const HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
// Abuse-block tras 15 errores 429 en 10 min (era 5). Reduce falsos positivos
// en sesiones power sin destrabar abuso real (el block sigue siendo 10 min).
const ABUSE_THRESHOLD_429 = 15;
const USAGE_DOC_TTL_DAYS = 7;
const LRU_MAX_USERS = 5_000;

const ENV_VARS_BY_PROVIDER: Record<BudgetProviderKey, string> = {
  deepseek: 'AGORA_AI_BUDGET_DEEPSEEK',
  openai: 'AGORA_AI_BUDGET_OPENAI',
  anthropic: 'AGORA_AI_BUDGET_ANTHROPIC',
  google: 'AGORA_AI_BUDGET_GOOGLE',
  custom: 'AGORA_AI_BUDGET_CUSTOM'
};

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function readFallbackBudget(): number {
  return readPositiveInt(process.env.AGORA_AI_DAILY_TOKEN_BUDGET, DEFAULT_FALLBACK_BUDGET);
}

function readProviderBudget(key: BudgetProviderKey): number {
  return readPositiveInt(process.env[ENV_VARS_BY_PROVIDER[key]], DEFAULT_BUDGETS[key]);
}

/**
 * Resuelve el budget aplicable: si el provider matchea un key canónico, usa
 * su env específico; si no, fallback global.
 */
export function resolveBudgetFor(provider: string | null | undefined): {
  budget: number;
  providerKey: BudgetProviderKey | null;
} {
  const key = normalizeProvider(provider);
  if (key === null) return { budget: readFallbackBudget(), providerKey: null };
  return { budget: readProviderBudget(key), providerKey: key };
}

function readHourlyCap(): number {
  return readPositiveInt(process.env.AGORA_AI_HOURLY_MESSAGE_CAP, DEFAULT_HOURLY_MESSAGE_CAP);
}

function dayKey(now: number): string {
  // YYYY-MM-DD en UTC — alineado con el "reset diario" a medianoche UTC.
  return new Date(now).toISOString().slice(0, 10);
}

function msUntilMidnightUtc(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0, 0, 0, 0
  );
  return Math.max(0, next - now);
}

// Seam para tests: permite reemplazar la fuente de docs sin tocar firebase-admin.
export interface UsageDocLike {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
}
type DocFactory = (uid: string, dayKey: string) => UsageDocLike;

const defaultFactory: DocFactory = (uid, day) => adminDb
  .collection('users')
  .doc(uid)
  .collection('agentUsage')
  .doc(`daily-${day}`) as unknown as UsageDocLike;

let docFactory: DocFactory = defaultFactory;

export function __setUsageDocFactoryForTest(factory: DocFactory | null): void {
  docFactory = factory ?? defaultFactory;
}

function usageDocRef(uid: string, now: number): UsageDocLike {
  return docFactory(uid, dayKey(now));
}

export interface DailyBudgetCheckOk {
  ok: true;
  used: number;
  budget: number;
  provider: BudgetProviderKey | null;
}
export interface DailyBudgetCheckBlocked {
  ok: false;
  reason: 'daily-token-budget';
  used: number;
  budget: number;
  provider: BudgetProviderKey | null;
  retryAfterMs: number;
}
export type DailyBudgetCheck = DailyBudgetCheckOk | DailyBudgetCheckBlocked;

/**
 * Extrae el contador de tokens (prompt + completion) del sub-doc del provider.
 * Si el doc viejo no tiene `byProvider`, devuelve 0 — es decir, los counters
 * por-provider arrancan en cero al primer call post-deploy, aunque el total
 * agregado refleje gasto previo. Es intencional: con el cap único anterior no
 * se podía atribuir el consumo por provider, así que tratamos esa sombra como
 * "consumo sin proveedor identificable" que no penaliza ningún cap específico.
 */
function readProviderUsed(data: Record<string, unknown> | null, providerKey: BudgetProviderKey | null): number {
  if (!data) return 0;
  if (providerKey === null) {
    // Fallback: comparamos contra el total agregado del doc.
    const pt = Number(data.promptTokens ?? 0);
    const ct = Number(data.completionTokens ?? 0);
    return (Number.isFinite(pt) ? pt : 0) + (Number.isFinite(ct) ? ct : 0);
  }
  const byProvider = data.byProvider;
  if (!byProvider || typeof byProvider !== 'object') return 0;
  const sub = (byProvider as Record<string, unknown>)[providerKey];
  if (!sub || typeof sub !== 'object') return 0;
  const subRec = sub as Record<string, unknown>;
  const pt = Number(subRec.promptTokens ?? 0);
  const ct = Number(subRec.completionTokens ?? 0);
  return (Number.isFinite(pt) ? pt : 0) + (Number.isFinite(ct) ? ct : 0);
}

/**
 * Lee el doc del día y bloquea si el total del *proveedor* alcanzó su budget.
 * Si el provider no matchea un key canónico, se compara contra el total agregado
 * con el budget de fallback global (`AGORA_AI_DAILY_TOKEN_BUDGET`).
 *
 * Si Firestore falla (network/permissions) deja pasar — preferimos disponibilidad
 * sobre cap estricto (el cap horario y el rate-limit IP siguen activos).
 */
export async function checkDailyBudget(
  uid: string,
  provider?: string | null,
  nowMs: number = Date.now()
): Promise<DailyBudgetCheck> {
  const { budget, providerKey } = resolveBudgetFor(provider);
  try {
    const snap = await usageDocRef(uid, nowMs).get();
    const data = snap.exists ? (snap.data() ?? null) : null;
    const used = readProviderUsed(data ?? null, providerKey);
    if (used >= budget) {
      return {
        ok: false,
        reason: 'daily-token-budget',
        used,
        budget,
        provider: providerKey,
        retryAfterMs: msUntilMidnightUtc(nowMs)
      };
    }
    return { ok: true, used, budget, provider: providerKey };
  } catch (error) {
    console.warn('[agora-ai/usage] checkDailyBudget fallback:', error instanceof Error ? error.message : error);
    return { ok: true, used: 0, budget, provider: providerKey };
  }
}

/**
 * Suma tokens consumidos al doc del día. Actualiza tanto `byProvider[key]` como
 * los totales globales (retro-compat). Idempotente vía FieldValue.increment
 * (no race entre instancias). Falla silenciosa: la observabilidad la cubre el
 * recordAbuseSignal con los tokens reales del run.
 *
 * Si el provider no matchea un key canónico, sólo actualiza los totales
 * globales — el bucket `byProvider` queda intacto.
 */
export async function recordUsage(
  uid: string,
  provider: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
  nowMs: number = Date.now()
): Promise<void> {
  const pt = Math.max(0, Math.floor(Number(promptTokens) || 0));
  const ct = Math.max(0, Math.floor(Number(completionTokens) || 0));
  if (pt === 0 && ct === 0) return;
  const providerKey = normalizeProvider(provider);
  try {
    const ref = usageDocRef(uid, nowMs);
    const expiresAtMs = nowMs + USAGE_DOC_TTL_DAYS * 24 * HOUR_MS;
    const payload: Record<string, unknown> = {
      promptTokens: FieldValue.increment(pt),
      completionTokens: FieldValue.increment(ct),
      requestCount: FieldValue.increment(1),
      lastResetAt: dayKey(nowMs),
      expiresAt: Timestamp.fromMillis(expiresAtMs)
    };
    if (providerKey !== null) {
      payload[`byProvider.${providerKey}.promptTokens`] = FieldValue.increment(pt);
      payload[`byProvider.${providerKey}.completionTokens`] = FieldValue.increment(ct);
    }
    await ref.set(payload, { merge: true });
  } catch (error) {
    console.warn('[agora-ai/usage] recordUsage error:', error instanceof Error ? error.message : error);
  }
}

// ---- Cap horario (in-memory sliding window con LRU implícito) ---------------

type SlidingWindow = number[]; // timestamps ms, sorted asc
const messageTimestamps = new Map<string, SlidingWindow>();

function pruneOldest(map: Map<string, SlidingWindow>) {
  if (map.size <= LRU_MAX_USERS) return;
  const firstKey = map.keys().next().value;
  if (firstKey !== undefined) map.delete(firstKey);
}

export interface HourlyCheckOk { ok: true; used: number; cap: number; }
export interface HourlyCheckBlocked {
  ok: false;
  reason: 'hourly-message-cap';
  used: number;
  cap: number;
  retryAfterMs: number;
}
export type HourlyCheck = HourlyCheckOk | HourlyCheckBlocked;

export function checkHourlyMessageCap(uid: string, nowMs: number = Date.now()): HourlyCheck {
  const cap = readHourlyCap();
  const list = messageTimestamps.get(uid) ?? [];
  const cutoff = nowMs - HOUR_MS;
  const live = list.filter((t) => t >= cutoff);
  if (live.length >= cap) {
    const oldest = live[0] ?? nowMs;
    const retryAfterMs = Math.max(0, oldest + HOUR_MS - nowMs);
    return { ok: false, reason: 'hourly-message-cap', used: live.length, cap, retryAfterMs };
  }
  return { ok: true, used: live.length, cap };
}

export function incrementMessageCount(uid: string, nowMs: number = Date.now()): void {
  const cutoff = nowMs - HOUR_MS;
  const list = (messageTimestamps.get(uid) ?? []).filter((t) => t >= cutoff);
  list.push(nowMs);
  // Re-insert para refrescar orden LRU.
  messageTimestamps.delete(uid);
  messageTimestamps.set(uid, list);
  pruneOldest(messageTimestamps);
}

// ---- Blocklist temporal por abuso de 429 -----------------------------------

type AbuseState = { events: number[]; blockedUntil: number };
const abuseState = new Map<string, AbuseState>();

export interface AbuseCheckOk { ok: true; }
export interface AbuseCheckBlocked {
  ok: false;
  reason: 'abuse-block';
  retryAfterMs: number;
}
export type AbuseCheck = AbuseCheckOk | AbuseCheckBlocked;

export function checkAbuseBlock(uid: string, nowMs: number = Date.now()): AbuseCheck {
  const state = abuseState.get(uid);
  if (!state) return { ok: true };
  if (state.blockedUntil > nowMs) {
    return { ok: false, reason: 'abuse-block', retryAfterMs: state.blockedUntil - nowMs };
  }
  return { ok: true };
}

/**
 * Llamar cada vez que se devuelve 429 al user. Si acumula
 * `ABUSE_THRESHOLD_429` en `TEN_MIN_MS`, lo metemos al blocklist durante
 * `TEN_MIN_MS` adicionales.
 */
export function recordAbuseSignal(uid: string, nowMs: number = Date.now()): { blocked: boolean; until: number } {
  const cutoff = nowMs - TEN_MIN_MS;
  const prev = abuseState.get(uid);
  const events = (prev?.events ?? []).filter((t) => t >= cutoff);
  events.push(nowMs);
  let blockedUntil = prev?.blockedUntil ?? 0;
  if (events.length >= ABUSE_THRESHOLD_429) {
    blockedUntil = nowMs + TEN_MIN_MS;
  }
  const next: AbuseState = { events, blockedUntil };
  abuseState.delete(uid);
  abuseState.set(uid, next);
  pruneOldest(abuseState as unknown as Map<string, SlidingWindow>);
  return { blocked: blockedUntil > nowMs, until: blockedUntil };
}

// ---- Señal estructurada de abuso para Cloud Logging ------------------------

export interface AbuseSignalPayload {
  uid: string;
  workspaceId: string;
  model: string;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  status: 'ok' | 'error' | 'rate-limited' | 'budget-exceeded' | 'blocked' | 'truncated';
}

export function logAbuseSignal(payload: AbuseSignalPayload): void {
  // Cloud Logging captura stdout/stderr y parsea JSON; usamos warn para que sea
  // fácil filtrar por severidad sin perder el contexto.
  console.warn('[agora-ai/abuse-signal]', JSON.stringify(payload));
}

// ---- Helpers de test (no exportar a runtime productivo críticos) -----------

/** Reset completo de los maps in-memory. Usado por tests para aislar casos. */
export function __resetUsageTrackingMemory(): void {
  messageTimestamps.clear();
  abuseState.clear();
}

export const __constantsForTest = {
  HOUR_MS,
  TEN_MIN_MS,
  ABUSE_THRESHOLD_429,
  USAGE_DOC_TTL_DAYS,
  DEFAULT_BUDGETS,
  DEFAULT_FALLBACK_BUDGET,
  DEFAULT_HOURLY_MESSAGE_CAP
};

export const __internalsForTest = {
  msUntilMidnightUtc,
  dayKey,
  readFallbackBudget,
  readProviderBudget,
  readHourlyCap,
  normalizeProvider,
  resolveBudgetFor,
  readProviderUsed
};
