type AgentRateBucket = {
  inFlight: number;
  lastStartedAt: number;
  lastTouchedAt: number;
};

const buckets = new Map<string, AgentRateBucket>();
const BUCKET_TTL_MS = 5 * 60 * 1000;

function cleanup(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.inFlight <= 0 && now - bucket.lastTouchedAt > BUCKET_TTL_MS) {
      buckets.delete(key);
    }
  }
}

export function claimAgoraAgentRequest(
  key: string,
  options: { minIntervalMs?: number; maxConcurrent?: number } = {}
) {
  const minIntervalMs = options.minIntervalMs ?? 900;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const now = Date.now();
  cleanup(now);

  const bucket = buckets.get(key) ?? { inFlight: 0, lastStartedAt: 0, lastTouchedAt: now };
  const sinceLastStart = now - bucket.lastStartedAt;
  if (bucket.inFlight >= maxConcurrent) {
    return {
      ok: false as const,
      retryAfterMs: Math.max(500, minIntervalMs),
      reason: 'concurrent-limit'
    };
  }
  if (sinceLastStart < minIntervalMs) {
    return {
      ok: false as const,
      retryAfterMs: minIntervalMs - sinceLastStart,
      reason: 'rapid-fire'
    };
  }

  bucket.inFlight += 1;
  bucket.lastStartedAt = now;
  bucket.lastTouchedAt = now;
  buckets.set(key, bucket);

  let released = false;
  return {
    ok: true as const,
    release: () => {
      if (released) return;
      released = true;
      const current = buckets.get(key);
      if (!current) return;
      current.inFlight = Math.max(0, current.inFlight - 1);
      current.lastTouchedAt = Date.now();
      buckets.set(key, current);
    }
  };
}
