/**
 * Rate limit compartido cross-instance para endpoints de auth.
 *
 * El rate limiter in-memory (un Map por proceso) no sirve en Cloud Run con
 * N>1 instancias: el atacante reparte intentos entre instancias y nunca llega
 * al cap. Persistimos el contador en Firestore (`authRateLimit/{docId}`) con
 * `FieldValue.increment` para que el conteo sea atómico entre instancias.
 *
 * Schema:
 *   authRateLimit/{docId}
 *     { count, windowStartMs, expiresAt }
 *
 * `expiresAt` (Timestamp) habilita TTL automático de Firestore para limpiar
 * docs viejos sin job manual (configurar TTL sobre `expiresAt` en consola).
 *
 * Fail-open: si Firestore falla (red/permisos) dejamos pasar — preferimos
 * disponibilidad del login sobre un cap estricto. El cap solo frena abuso
 * sostenido, no es una barrera de seguridad dura por sí solo.
 */
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

const COLLECTION = 'authRateLimit';

export interface AuthRateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export interface AuthRateLimitOptions {
  windowMs: number;
  maxAttempts: number;
}

interface RateLimitDocLike {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
}
type DocFactory = (docId: string) => RateLimitDocLike;

const defaultFactory: DocFactory = (docId) => adminDb
  .collection(COLLECTION)
  .doc(docId) as unknown as RateLimitDocLike;

let docFactory: DocFactory = defaultFactory;

export function __setAuthRateLimitDocFactoryForTest(factory: DocFactory | null): void {
  docFactory = factory ?? defaultFactory;
}

// Firestore no acepta '/' ni espacios en el doc id; sanitizamos la llave
// derivada de IP/email a un id seguro y acotado en longitud.
function safeDocId(key: string): string {
  return encodeURIComponent(key).replace(/[/.#$[\]]/g, '_').slice(0, 1500) || 'unknown';
}

/**
 * Lee el estado de `key` y decide si el límite está excedido, SIN incrementar.
 * Usar al inicio del handler para bloquear; el incremento se hace aparte con
 * `recordAuthAttempt` (p.ej. solo en intentos fallidos de login).
 *
 * Ventana fija: al primer intento se fija `windowStartMs`; cuando expira, el
 * contador se reinicia. No es sliding window, pero es suficiente como freno y
 * evita leer N timestamps por request.
 */
export async function checkAuthRateLimit(
  key: string,
  { windowMs, maxAttempts }: AuthRateLimitOptions,
  nowMs: number = Date.now()
): Promise<AuthRateLimitResult> {
  const docId = safeDocId(key);
  try {
    const snap = await docFactory(docId).get();
    const data = snap.exists ? (snap.data() ?? {}) : {};

    const rawStart = Number(data.windowStartMs ?? 0);
    const windowStartMs = Number.isFinite(rawStart) ? rawStart : 0;
    const rawCount = Number(data.count ?? 0);
    const count = Number.isFinite(rawCount) ? rawCount : 0;

    const windowExpired = nowMs - windowStartMs >= windowMs;
    if (!windowExpired && count >= maxAttempts) {
      const retryAfterMs = Math.max(0, windowStartMs + windowMs - nowMs);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    return { ok: true, retryAfterSeconds: 0 };
  } catch (error) {
    console.warn('[auth-rate-limit] check fallback (fail-open):', error instanceof Error ? error.message : error);
    return { ok: true, retryAfterSeconds: 0 };
  }
}

/**
 * Incrementa el contador de `key`. Si la ventana expiró, la reinicia. Atómico
 * cross-instance vía FieldValue.increment. Fail-silent: si Firestore falla, el
 * intento simplemente no se contabiliza (preferimos no romper el flujo de auth).
 */
export async function recordAuthAttempt(
  key: string,
  { windowMs }: Pick<AuthRateLimitOptions, 'windowMs'>,
  nowMs: number = Date.now()
): Promise<void> {
  const docId = safeDocId(key);
  try {
    const ref = docFactory(docId);
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() ?? {}) : {};
    const rawStart = Number(data.windowStartMs ?? 0);
    const windowStartMs = Number.isFinite(rawStart) ? rawStart : 0;
    const windowExpired = nowMs - windowStartMs >= windowMs;

    if (windowExpired) {
      await ref.set(
        { count: 1, windowStartMs: nowMs, expiresAt: Timestamp.fromMillis(nowMs + windowMs) },
        { merge: true }
      );
    } else {
      await ref.set(
        { count: FieldValue.increment(1), expiresAt: Timestamp.fromMillis(windowStartMs + windowMs) },
        { merge: true }
      );
    }
  } catch (error) {
    console.warn('[auth-rate-limit] record fallback:', error instanceof Error ? error.message : error);
  }
}

export const __internalsForTest = { safeDocId };
