/** A fixed-window, in-memory rate limiter keyed by client IP. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    }, windowMs).unref();
  }

  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return { allowed: entry.count <= this.max, retryAfterMs: entry.resetAt - now };
  }
}
