/** Thrown by ConcurrencyLimiter.run when every slot is busy and the queue is full. */
export class ConcurrencyLimitExceededError extends Error {
  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    super(`Concurrency limit reached (${maxConcurrent} running, ${maxQueue} queued)`);
    this.name = 'ConcurrencyLimitExceededError';
  }

  static is(error: unknown): error is ConcurrencyLimitExceededError {
    return error instanceof ConcurrencyLimitExceededError;
  }
}

/**
 * Small in-process semaphore with a bounded FIFO queue. Used around memory-heavy work reachable
 * without authentication (scrypt password verification at 128 MiB per call): at most
 * `maxConcurrent` tasks run, up to `maxQueue` wait, and anything beyond is refused at once
 * (the caller answers 429) instead of exhausting the process memory.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('ConcurrencyLimiter needs at least one slot');
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new Error('ConcurrencyLimiter queue length must be a non-negative integer');
    }
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
    } else if (this.waiting.length < this.maxQueue) {
      // The releasing task hands its slot over directly (active stays the same).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      throw new ConcurrencyLimitExceededError(this.maxConcurrent, this.maxQueue);
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}
