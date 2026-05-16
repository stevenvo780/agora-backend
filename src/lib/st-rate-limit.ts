interface BucketState {
  tokens: number;
  lastRefillAt: number;
}

const CAPACITY = 60;
const REFILL_RATE_PER_MS = CAPACITY / 60_000;

const buckets = new Map<string, BucketState>();

export function checkRateLimit(keyHash: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const existing = buckets.get(keyHash);

  let tokens: number;
  if (!existing) {
    tokens = CAPACITY;
  } else {
    const elapsed = now - existing.lastRefillAt;
    tokens = Math.min(CAPACITY, existing.tokens + elapsed * REFILL_RATE_PER_MS);
  }

  if (tokens < 1) {
    const retryAfterMs = Math.ceil((1 - tokens) / REFILL_RATE_PER_MS);
    buckets.set(keyHash, { tokens, lastRefillAt: now });
    return { allowed: false, retryAfterMs };
  }

  buckets.set(keyHash, { tokens: tokens - 1, lastRefillAt: now });
  return { allowed: true };
}

export function _resetBuckets(): void {
  buckets.clear();
}
