/** Small in-memory fixed-window attempt limiter (per process). */
export interface AttemptLimiter {
  /** Registers an attempt; returns the seconds to wait when over the limit, else 0. */
  hit(key: string): number;
  reset(): void;
}

export function createAttemptLimiter(
  limit: number,
  windowMs: number,
  maxKeys = 5000
): AttemptLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key) {
      const now = Date.now();
      if (buckets.size > maxKeys) {
        for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
        if (buckets.size > maxKeys) buckets.clear();
      }
      const current = buckets.get(key);
      if (!current || current.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return 0;
      }
      current.count += 1;
      return current.count > limit ? Math.max(1, Math.ceil((current.resetAt - now) / 1000)) : 0;
    },
    reset() {
      buckets.clear();
    },
  };
}
