/**
 * Auth HMAC para workers. Los workers no son usuarios Firebase; identifican
 * una workspace vía `WORKER_TOKEN` (= workspaceId) firmado con el
 * `WORKER_SYNC_SECRET` compartido del host (`WORKER_SECRET` queda como fallback
 * legacy; `WORKER_SECRET_PREVIOUS` permite rotar sin downtime).
 *
 * Headers:
 *   X-Worker-Token: <workspaceId>          (`personal:<uid>` o `personal` para personal)
 *   X-Worker-Ts:    <unix-ms>
 *   X-Worker-Sig:   hex(hmacSha256(secret, `${token}:${ts}${uidPart}`))
 *   X-Worker-Uid:   <uid>                   (requerido cuando token es `personal`)
 *
 * Para personal workspaces el uid se incluye en la firma como `:${uid}`.
 * Validez: ±5 min de skew.
 */
import crypto from 'node:crypto';
import type { NextRequest } from '@/lib/http/next-server';
import { env } from '@/lib/env';

const MAX_SKEW_MS = 5 * 60 * 1000;

export interface WorkerAuthContext {
  workspaceId: string;
  /** Uid del owner si es personal workspace, null si es shared. */
  userId: string | null;
  ts: number;
}

const getWorkerAuthSecrets = () => Array.from(new Set([
  env.WORKER_SYNC_SECRET(),
  env.WORKER_SECRET(),
  env.WORKER_SECRET_PREVIOUS()
].filter(Boolean)));

export const isWorkerAuthConfigured = () => getWorkerAuthSecrets().length > 0;

const isPersonalToken = (token: string) => token === 'personal' || token.startsWith('personal:');

export const buildWorkerAuthSignature = (secret: string, token: string, ts: number, userId: string | null = null) => {
  const uidPart = userId ? `:${userId}` : '';
  return crypto.createHmac('sha256', secret).update(`${token}:${ts}${uidPart}`).digest('hex');
};

export const verifyWorkerAuth = (req: NextRequest): WorkerAuthContext | null => {
  const secrets = getWorkerAuthSecrets();
  if (secrets.length === 0) return null;
  const token = req.headers.get('x-worker-token');
  const tsStr = req.headers.get('x-worker-ts');
  const sig = req.headers.get('x-worker-sig');
  const uidHeader = req.headers.get('x-worker-uid') ?? '';
  if (!token || !tsStr || !sig) return null;

  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return null;
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return null;

  // Resolver uid: viene en el header (`x-worker-uid`) o embebido en el token
  // (`personal:<uid>`).
  let userId: string | null = null;
  if (isPersonalToken(token)) {
    if (token.startsWith('personal:')) userId = token.slice('personal:'.length);
    if (!userId) userId = uidHeader || null;
    if (!userId) return null;
  }

  let ok = false;
  for (const secret of secrets) {
    const expected = buildWorkerAuthSignature(secret, token, ts, userId);
    let match = expected.length === sig.length;
    if (match) {
      try { match = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex')); }
      catch { match = false; }
    }
    if (match) {
      ok = true;
      break;
    }
  }
  if (!ok) return null;

  return { workspaceId: token, userId, ts };
};
