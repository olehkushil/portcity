/**
 * Long retry policy for the `payment.succeeded` consumer (the member paid; the barrier must open
 * and the session must show paid, so the job keeps retrying for hours instead of the outbox
 * default of 3 attempts within seconds). Implemented on the job itself: on failure the job is
 * moved back to the delayed set (BullMQ `moveToDelayed` + `DelayedError`, which does not consume
 * an attempt) with an exponential delay, and its own counter is kept in the job data.
 */
export interface LongRetryPolicy {
  /** Retries after the first failure. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** 30 s, 1, 2, 4, 8, 16 min, then every 30 min: 40 retries cover roughly 17 hours. */
export const PAYMENT_SUCCEEDED_RETRY: LongRetryPolicy = Object.freeze({
  maxRetries: 40,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
});

/** Key in the job data that counts the retries done so far. */
export const LONG_RETRY_COUNTER = 'parkingRetries';

/** Delay before retry number `retry` (1-based), or null when the policy is exhausted. */
export function longRetryDelayMs(retry: number, policy: LongRetryPolicy): number | null {
  if (!Number.isSafeInteger(retry) || retry < 1 || retry > policy.maxRetries) {
    return null;
  }
  const exponent = Math.min(retry - 1, 30);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

/** The slice of a BullMQ job the wrapper needs (a fake in unit tests). */
export interface RetryableJob<T extends object> {
  data: T;
  updateData(data: T): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/**
 * Runs `handler`; on failure schedules the next try per the policy and throws `delayedError()`
 * (BullMQ's DelayedError: the worker leaves the job delayed instead of failing it). Without a
 * worker token (tests, manual runs) or after the last retry the original error is rethrown.
 */
export async function runWithLongRetry<T extends object, R>(
  job: RetryableJob<T>,
  token: string | undefined,
  handler: () => Promise<R>,
  options: {
    policy: LongRetryPolicy;
    now: () => number;
    delayedError: () => Error;
    log?: (message: string) => void;
  },
): Promise<R> {
  try {
    return await handler();
  } catch (error) {
    const done = Number((job.data as Record<string, unknown>)[LONG_RETRY_COUNTER] ?? 0);
    const retry = (Number.isFinite(done) ? done : 0) + 1;
    const delay = longRetryDelayMs(retry, options.policy);
    if (delay === null || !token) {
      throw error;
    }
    await job.updateData({ ...job.data, [LONG_RETRY_COUNTER]: retry });
    await job.moveToDelayed(options.now() + delay, token);
    options.log?.(
      `retry ${retry}/${options.policy.maxRetries} in ${Math.round(delay / 1000)} s: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw options.delayedError();
  }
}
