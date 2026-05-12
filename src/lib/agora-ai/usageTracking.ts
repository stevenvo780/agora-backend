/**
 * Rate limiting fino + abuse prevention para el agente IA.
 *
 * Capas:
 *  1. Cap diario de tokens por user (Firestore, persiste cross-instance).
 *  2. Cap horario de mensajes por user (in-memory, sliding window).
 *  3. Bloqueo automático si user acumula N×429 en ventana corta.
 *  4. Señal estructurada de abuso (Cloud Logging — log-based metric futura).
 *
 * Firestore schema:
 *   users/{uid}/agentUsage/daily-{YYYY-MM-DD}
 *     { promptTokens, completionTokens, requestCount, lastResetAt, expiresAt }
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

const DEFAULT_DAILY_TOKEN_BUDGET = 100_000;
const DEFAULT_HOURLY_MESSAGE_CAP = 100;
const HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const ABUSE_THRESHOLD_429 = 5;
const USAGE_DOC_TTL_DAYS = 7;
const LRU_MAX_USERS = 5_000;

function readDailyBudget(): number {
  const raw = (process.env.AGORA_AI_DAILY_TOKEN_BUDGET ?? '').trim();
  if (!raw) return DEFAULT_DAILY_TOKEN_BUDGET;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_TOKEN_BUDGET;
  return Math.floor(n);
}

function readHourlyCap(): number {
  const raw = (process.env.AGORA_AI_HOURLY_MESSAGE_CAP ?? '').trim();
  if (!raw) return DEFAULT_HOURLY_MESSAGE_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOURLY_MESSAGE_CAP;
  return Math.floor(n);
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
}
export interface DailyBudgetCheckBlocked {
  ok: false;
  reason: 'daily-token-budget';
  used: number;
  budget: number;
  retryAfterMs: number;
}
export type DailyBudgetCheck = DailyBudgetCheckOk | DailyBudgetCheckBlocked;

/**
 * Lee el doc del día y bloquea si el total ya alcanzó el budget configurado.
 * Si Firestore falla (network/permissions) deja pasar — preferimos disponibilidad
 * sobre cap estricto (el cap horario y el rate-limit IP siguen activos).
 */
export async function checkDailyBudget(uid: string, nowMs: number = Date.now()): Promise<DailyBudgetCheck> {
  const budget = readDailyBudget();
  try {
    const snap = await usageDocRef(uid, nowMs).get();
    const data = snap.exists ? snap.data() : null;
    const promptTokens = Number(data?.promptTokens ?? 0);
    const completionTokens = Number(data?.completionTokens ?? 0);
    const used = (Number.isFinite(promptTokens) ? promptTokens : 0)
      + (Number.isFinite(completionTokens) ? completionTokens : 0);
    if (used >= budget) {
      return {
        ok: false,
        reason: 'daily-token-budget',
        used,
        budget,
        retryAfterMs: msUntilMidnightUtc(nowMs)
      };
    }
    return { ok: true, used, budget };
  } catch (error) {
    console.warn('[agora-ai/usage] checkDailyBudget fallback:', error instanceof Error ? error.message : error);
    return { ok: true, used: 0, budget };
  }
}

/**
 * Suma tokens consumidos al doc del día. Idempotente vía FieldValue.increment
 * (no race entre instancias). Falla silenciosa: la observabilidad la cubre el
 * recordAbuseSignal con los tokens reales del run.
 */
export async function recordUsage(
  uid: string,
  promptTokens: number,
  completionTokens: number,
  nowMs: number = Date.now()
): Promise<void> {
  const pt = Math.max(0, Math.floor(Number(promptTokens) || 0));
  const ct = Math.max(0, Math.floor(Number(completionTokens) || 0));
  if (pt === 0 && ct === 0) return;
  try {
    const ref = usageDocRef(uid, nowMs);
    const expiresAtMs = nowMs + USAGE_DOC_TTL_DAYS * 24 * HOUR_MS;
    await ref.set({
      promptTokens: FieldValue.increment(pt),
      completionTokens: FieldValue.increment(ct),
      requestCount: FieldValue.increment(1),
      lastResetAt: dayKey(nowMs),
      expiresAt: Timestamp.fromMillis(expiresAtMs)
    }, { merge: true });
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
  DEFAULT_DAILY_TOKEN_BUDGET,
  DEFAULT_HOURLY_MESSAGE_CAP
};

export const __internalsForTest = {
  msUntilMidnightUtc,
  dayKey,
  readDailyBudget,
  readHourlyCap
};
