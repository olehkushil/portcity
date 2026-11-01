import type { JobsOptions, RepeatOptions } from 'bullmq';

export interface InMemoryJob<T = unknown> {
  id: string;
  name: string;
  data: T;
  opts: JobsOptions | undefined;
  timestamp: number;
}

export interface InMemoryScheduler {
  id: string;
  repeat: Omit<RepeatOptions, 'key'>;
  template: { name?: string; data?: unknown; opts?: JobsOptions } | undefined;
}

/**
 * Producer-side stand-in for a BullMQ Queue when QUEUE_DRIVER=memory (tests, openapi script,
 * API without Redis). Jobs are recorded, never processed; tests inspect `jobs`.
 */
export class InMemoryQueue {
  readonly jobs: InMemoryJob[] = [];
  readonly schedulers = new Map<string, InMemoryScheduler>();
  private counter = 0;

  constructor(readonly name: string) {}

  async add<T>(name: string, data: T, opts?: JobsOptions): Promise<InMemoryJob<T>> {
    const requestedId = opts?.jobId !== undefined ? String(opts.jobId) : undefined;
    if (requestedId !== undefined) {
      const existing = this.jobs.find((job) => job.id === requestedId);
      if (existing) {
        // BullMQ ignores a second add with the same jobId.
        return existing as InMemoryJob<T>;
      }
    }
    this.counter += 1;
    const job: InMemoryJob<T> = {
      id: requestedId ?? String(this.counter),
      name,
      data,
      opts,
      timestamp: Date.now(),
    };
    this.jobs.push(job);
    return job;
  }

  async addBulk<T>(
    entries: Array<{ name: string; data: T; opts?: JobsOptions }>,
  ): Promise<InMemoryJob<T>[]> {
    const added: InMemoryJob<T>[] = [];
    for (const entry of entries) {
      added.push(await this.add(entry.name, entry.data, entry.opts));
    }
    return added;
  }

  async upsertJobScheduler(
    id: string,
    repeat: Omit<RepeatOptions, 'key'>,
    template?: { name?: string; data?: unknown; opts?: JobsOptions },
  ): Promise<null> {
    this.schedulers.set(id, { id, repeat, template });
    return null;
  }

  async removeJobScheduler(id: string): Promise<boolean> {
    return this.schedulers.delete(id);
  }

  async getJob(id: string): Promise<InMemoryJob | undefined> {
    return this.jobs.find((job) => job.id === id);
  }

  async count(): Promise<number> {
    return this.jobs.length;
  }

  async getJobCounts(): Promise<Record<string, number>> {
    return { waiting: this.jobs.length, active: 0, completed: 0, failed: 0, delayed: 0 };
  }

  async drain(): Promise<void> {
    this.jobs.length = 0;
  }

  async waitUntilReady(): Promise<this> {
    return this;
  }

  async close(): Promise<void> {
    // nothing to release
  }

  jobsNamed(name: string): InMemoryJob[] {
    return this.jobs.filter((job) => job.name === name);
  }

  clear(): void {
    this.jobs.length = 0;
    this.schedulers.clear();
  }
}
