import {
  LONG_RETRY_COUNTER,
  PAYMENT_SUCCEEDED_RETRY,
  type RetryableJob,
  longRetryDelayMs,
  runWithLongRetry,
} from './long-retry';

class FakeJob implements RetryableJob<Record<string, unknown>> {
  delayedUntil: number | null = null;
  tokens: Array<string | undefined> = [];

  constructor(public data: Record<string, unknown>) {}

  async updateData(data: Record<string, unknown>): Promise<void> {
    this.data = data;
  }

  async moveToDelayed(timestamp: number, token?: string): Promise<void> {
    this.delayedUntil = timestamp;
    this.tokens.push(token);
  }
}

class DelayedForTest extends Error {}

const options = {
  policy: PAYMENT_SUCCEEDED_RETRY,
  now: () => 1_000_000,
  delayedError: () => new DelayedForTest('delayed'),
};

describe('long retry policy for payment.succeeded (finding 4)', () => {
  it('grows exponentially to 30 minutes and stops after 40 retries (about 17 hours)', () => {
    expect(longRetryDelayMs(1, PAYMENT_SUCCEEDED_RETRY)).toBe(30_000);
    expect(longRetryDelayMs(2, PAYMENT_SUCCEEDED_RETRY)).toBe(60_000);
    expect(longRetryDelayMs(6, PAYMENT_SUCCEEDED_RETRY)).toBe(960_000);
    expect(longRetryDelayMs(7, PAYMENT_SUCCEEDED_RETRY)).toBe(1_800_000);
    expect(longRetryDelayMs(40, PAYMENT_SUCCEEDED_RETRY)).toBe(1_800_000);
    expect(longRetryDelayMs(41, PAYMENT_SUCCEEDED_RETRY)).toBeNull();
    expect(longRetryDelayMs(0, PAYMENT_SUCCEEDED_RETRY)).toBeNull();
    let total = 0;
    for (let retry = 1; retry <= PAYMENT_SUCCEEDED_RETRY.maxRetries; retry += 1) {
      total += longRetryDelayMs(retry, PAYMENT_SUCCEEDED_RETRY) ?? 0;
    }
    expect(total / 3_600_000).toBeGreaterThan(16);
  });

  it('returns the handler result without touching the job', async () => {
    const job = new FakeJob({ eventId: 'e' });
    await expect(runWithLongRetry(job, 'token', async () => 'ok', options)).resolves.toBe('ok');
    expect(job.delayedUntil).toBeNull();
  });

  it('moves a failed job back to the delayed set and counts the retry', async () => {
    const job = new FakeJob({ eventId: 'e' });
    const failing = async (): Promise<string> => {
      throw new Error('barrier API down');
    };
    await expect(runWithLongRetry(job, 'token', failing, options)).rejects.toBeInstanceOf(
      DelayedForTest,
    );
    expect(job.data[LONG_RETRY_COUNTER]).toBe(1);
    expect(job.delayedUntil).toBe(1_000_000 + 30_000);
    expect(job.tokens).toEqual(['token']);

    await expect(runWithLongRetry(job, 'token', failing, options)).rejects.toBeInstanceOf(
      DelayedForTest,
    );
    expect(job.data[LONG_RETRY_COUNTER]).toBe(2);
    expect(job.delayedUntil).toBe(1_000_000 + 60_000);
  });

  it('rethrows the original error when exhausted or without a worker token', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('still down');
    };
    const exhausted = new FakeJob({ [LONG_RETRY_COUNTER]: 40 });
    await expect(runWithLongRetry(exhausted, 'token', failing, options)).rejects.toThrow(
      'still down',
    );
    const manual = new FakeJob({});
    await expect(runWithLongRetry(manual, undefined, failing, options)).rejects.toThrow(
      'still down',
    );
    expect(manual.delayedUntil).toBeNull();
  });
});
