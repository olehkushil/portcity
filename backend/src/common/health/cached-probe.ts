/**
 * Memoises an async probe for `ttlMs`: callers within the window (including concurrent ones while
 * the probe is still running) share one result, so a flood of `/ready` requests costs at most one
 * database round trip per window. Failures are cached the same way (a down database is reported
 * as down for the whole window instead of being hammered).
 */
export class CachedProbe<T> {
  private cached: { startedAt: number; value: Promise<T> } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly nowMs: () => number,
  ) {}

  get(load: () => PromiseLike<T> | T): Promise<T> {
    const now = this.nowMs();
    if (this.cached && now - this.cached.startedAt < this.ttlMs && now >= this.cached.startedAt) {
      return this.cached.value;
    }
    const value = Promise.resolve().then(load);
    // Keep a handled branch so a cached rejection never surfaces as an unhandled rejection.
    value.catch(() => undefined);
    this.cached = { startedAt: now, value };
    return value;
  }

  reset(): void {
    this.cached = null;
  }
}
