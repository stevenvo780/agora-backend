/**
 * Contrato del documento `syncEventsOutbox`. El drainer reintenta publicar
 * estos a RTDB; si el shape está corrupto el drainer debe expirar el doc
 * en vez de explotar.
 */
import { err, isBool, isNumber, isObject, isString, ok, type ParseResult } from './result';

export interface OutboxRecord {
  id: string;
  rtdbPath: string;
  payload: Record<string, unknown>;
  ts: number;
  retryCount: number;
  published: boolean;
}

const STRIP_KEYS = new Set(['rtdbPath', 'published', 'createdAt', 'publishedAt', 'expiredAt', 'expiredReason', 'retryCount', 'lastRetryAt', 'lastError']);

export const parseOutboxRecord = (id: string, raw: unknown): ParseResult<OutboxRecord> => {
  if (!isObject(raw)) return err('outbox doc data is not an object');
  if (!isString(raw.rtdbPath) || !raw.rtdbPath) return err('outbox missing rtdbPath');
  const ts = isNumber(raw.ts) ? raw.ts : 0;
  const retryCount = isNumber(raw.retryCount) ? raw.retryCount : 0;
  const published = isBool(raw.published) ? raw.published : false;

  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (STRIP_KEYS.has(k)) continue;
    payload[k] = v;
  }

  return ok({ id, rtdbPath: raw.rtdbPath, payload, ts, retryCount, published });
};
