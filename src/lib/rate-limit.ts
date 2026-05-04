import type { RequestHandler } from 'express';

interface RateLimitOptions {
  windowMs: number;
  maxPerWindow: number;
  keyPrefix?: string;
}

export function createSlidingWindowRateLimiter({ windowMs, maxPerWindow, keyPrefix = '' }: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  const check = (rawKey: string, now = Date.now()) => {
    const key = `${keyPrefix}${rawKey}`;
    const start = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((ts) => ts > start);
    if (recent.length >= maxPerWindow) {
      hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(0, windowMs - (now - recent[0]!)) };
    }
    recent.push(now);
    hits.set(key, recent);
    return { ok: true, retryAfterMs: 0 };
  };

  const reset = () => hits.clear();

  return { check, reset };
}

export function createRateLimitMiddleware(options: RateLimitOptions): RequestHandler {
  const limiter = createSlidingWindowRateLimiter(options);
  return (req, res, next) => {
    const key = req.ip || req.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const result = limiter.check(`${req.method}:${req.path}:${key}`);
    if (result.ok) return next();
    res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    res.status(429).json({ error: 'rate_limited', retryAfterMs: result.retryAfterMs });
  };
}
