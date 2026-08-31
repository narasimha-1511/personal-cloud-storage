// In-memory fixed-window rate limiter. Good enough for a single-instance
// private app; resets on restart.

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the request is allowed. */
  hit(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      // Opportunistic cleanup so the map cannot grow without bound.
      if (this.windows.size > 10_000) {
        for (const [k, v] of this.windows) {
          if (now >= v.resetAt) this.windows.delete(k);
        }
      }
      return true;
    }
    w.count += 1;
    return w.count <= this.max;
  }
}
