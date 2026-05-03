/**
 * Auth HMAC para workers. Los workers no son usuarios Firebase; identifican
 * una workspace vía `WORKER_TOKEN` (= workspaceId) firmado con el
 * `WORKER_SECRET` compartido del host.
 *
 * Headers:
 *   X-Worker-Token: <workspaceId>          (`personal:<uid>` o `personal` para personal)
 *   X-Worker-Ts:    <unix-ms>
 *   X-Worker-Sig:   hex(hmacSha256(WORKER_SECRET, `${token}:${ts}${uidPart}`))
 *   X-Worker-Uid:   <uid>                   (requerido cuando token es `personal`)
 *
 * Para personal workspaces el uid se incluye en la firma como `:${uid}`.
 * Validez: ±5 min de skew.
 */
import crypto from 'node:crypto';
import type { NextRequest } from '@/lib/http/next-server';
import { env } from '@/lib/env';

const SECRET = env.WORKER_SECRET();
const MAX_SKEW_MS = 5 * 60 * 1000;

export interface WorkerAuthContext {
  workspaceId: string;
  /** Uid del owner si es personal workspace, null si es shared. */
  userId: string | null;
  ts: number;
}

export const isWorkerAuthConfigured = () => SECRET.length > 0;

const isPersonalToken = (token: string) => token === 'personal' || token.startsWith('personal:');

export const verifyWorkerAuth = (req: NextRequest): WorkerAuthContext | null => {
  if (!SECRET) return null;
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

  const uidPart = userId ? `:${userId}` : '';
  const expected = crypto.createHmac('sha256', SECRET).update(`${token}:${ts}${uidPart}`).digest('hex');
  let ok = expected.length === sig.length;
  if (ok) {
    try { ok = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex')); }
    catch { ok = false; }
  }
  if (!ok) return null;

  return { workspaceId: token, userId, ts };
};
