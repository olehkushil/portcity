/**
 * In-process sliding-window counter for failed logins per key (IP network). `hit()` reports
 * `burst: true` exactly once per window crossing, when the count reaches the threshold, so the
 * caller logs and audits a burst once instead of on every failure. Memory is bounded: old hits
 * are pruned on every call and at most `maxKeys` keys are tracked (oldest dropped first).
 * Per replica by design: the per-account counter in the database is the hard limit, this only
 * makes credential-stuffing waves visible.
 */
export class FailureBurstTracker {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly threshold: number,
    private readonly maxKeys = 10_000,
  ) {}

  hit(key: string, nowMs: number): { count: number; burst: boolean } {
    const from = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > from);
    recent.push(nowMs);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) {
        this.hits.delete(oldest);
      }
    }
    return { count: recent.length, burst: recent.length === this.threshold };
  }

  get trackedKeys(): number {
    return this.hits.size;
  }
}
