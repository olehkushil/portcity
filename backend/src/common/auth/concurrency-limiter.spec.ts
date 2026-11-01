import { ConcurrencyLimitExceededError, ConcurrencyLimiter } from './concurrency-limiter';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('ConcurrencyLimiter', () => {
  it('runs at most maxConcurrent tasks, queues up to maxQueue and refuses the rest', async () => {
    const limiter = new ConcurrencyLimiter(2, 1);
    const gates = [deferred(), deferred(), deferred()];
    let peak = 0;
    let running = 0;
    const task = (index: number) => () =>
      (async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gates[index]?.promise;
        running -= 1;
        return index;
      })();

    const first = limiter.run(task(0));
    const second = limiter.run(task(1));
    const third = limiter.run(task(2));
    await tick();
    expect([limiter.running, limiter.queued]).toEqual([2, 1]);

    await expect(limiter.run(task(0))).rejects.toBeInstanceOf(ConcurrencyLimitExceededError);

    gates[0]?.resolve();
    await expect(first).resolves.toBe(0);
    await tick();
    // The released slot went to the queued task directly.
    expect([limiter.running, limiter.queued]).toEqual([2, 0]);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await expect(Promise.all([second, third])).resolves.toEqual([1, 2]);
    expect(peak).toBe(2);
    expect([limiter.running, limiter.queued]).toEqual([0, 0]);
  });

  it('releases the slot when a task fails', async () => {
    const limiter = new ConcurrencyLimiter(1, 0);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(limiter.running).toBe(0);
  });

  it('validates its configuration', () => {
    expect(() => new ConcurrencyLimiter(0, 1)).toThrow();
    expect(() => new ConcurrencyLimiter(1, -1)).toThrow();
    expect(ConcurrencyLimitExceededError.is(new ConcurrencyLimitExceededError(1, 0))).toBe(true);
  });
});
