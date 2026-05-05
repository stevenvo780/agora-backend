import crypto from 'node:crypto';

export function resolveInternalToolSecret(env: NodeJS.ProcessEnv = process.env) {
  return (env.BACKEND_INTERNAL_SECRET || env.HUB_INTERNAL_SECRET || '').trim();
}

export function isInternalToolSecretAuthorized(provided: string, expected: string) {
  if (!expected) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const max = Math.max(providedBuf.length, expectedBuf.length);
  const a = Buffer.alloc(max);
  const b = Buffer.alloc(max);
  providedBuf.copy(a);
  expectedBuf.copy(b);
  const equal = crypto.timingSafeEqual(a, b);
  return equal && providedBuf.length === expectedBuf.length;
}
