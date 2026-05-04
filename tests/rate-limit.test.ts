import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlidingWindowRateLimiter } from '../src/lib/rate-limit.ts';

test('backend rate limiter aísla llaves y calcula retryAfter', () => {
  const limiter = createSlidingWindowRateLimiter({ windowMs: 10_000, maxPerWindow: 2 });

  assert.deepEqual(limiter.check('ip-1', 1000), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.check('ip-1', 2000), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.check('ip-2', 3000), { ok: true, retryAfterMs: 0 });
  assert.deepEqual(limiter.check('ip-1', 4000), { ok: false, retryAfterMs: 7000 });
  assert.deepEqual(limiter.check('ip-1', 11_001), { ok: true, retryAfterMs: 0 });
});
