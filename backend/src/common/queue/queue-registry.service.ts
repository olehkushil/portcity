import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config';
import { buildBullQueueOptions } from './bull-options';
import { InMemoryQueue } from './in-memory-queue';

/** Producer-side queue handle: a real BullMQ Queue or the in-memory stand-in. */
export type QueueHandle = Queue | InMemoryQueue;

/**
 * Creates and tracks queue instances for `QueueModule.registerQueue()`, picks the driver
 * from configuration and closes every queue on shutdown.
 */
@Injectable()
export class QueueRegistry implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly queues = new Map<string, QueueHandle>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly moduleRef: ModuleRef,
  ) {}

  get isMemory(): boolean {
    return this.config.QUEUE_DRIVER === 'memory';
  }

  /** Idempotent: a second registration of the same name returns the existing instance. */
  create(name: string): QueueHandle {
    const existing = this.queues.get(name);
    if (existing) {
      return existing;
    }
    const queue: QueueHandle = this.isMemory
      ? new InMemoryQueue(name)
      : new Queue(name, buildBullQueueOptions(this.config));
    if (queue instanceof Queue) {
      queue.on('error', (error: Error) =>
        this.logger.warn(`Queue "${name}" connection error: ${error.message}`),
      );
    }
    this.queues.set(name, queue);
    return queue;
  }

  /** Resolves a queue by name; falls back to the Nest container for queues registered with BullModule directly. */
  get(name: string): QueueHandle {
    const own = this.queues.get(name);
    if (own) {
      return own;
    }
    try {
      return this.moduleRef.get<QueueHandle>(getQueueToken(name), { strict: false });
    } catch (error) {
      throw new Error(
        `Queue "${name}" is not registered. Import QueueModule.registerQueue('${name}') in the owning module.`,
        { cause: error },
      );
    }
  }

  tryGet(name: string): QueueHandle | undefined {
    try {
      return this.get(name);
    } catch {
      return undefined;
    }
  }

  /** In-memory queue for assertions in tests (throws in redis mode). */
  getInMemory(name: string): InMemoryQueue {
    const queue = this.get(name);
    if (!(queue instanceof InMemoryQueue)) {
      throw new Error(
        `Queue "${name}" is not an in-memory queue (QUEUE_DRIVER=${this.config.QUEUE_DRIVER})`,
      );
    }
    return queue;
  }

  names(): string[] {
    return [...this.queues.keys()].sort();
  }

  async onApplicationShutdown(): Promise<void> {
    const closing = [...this.queues.values()].map((queue) => queue.close());
    const results = await Promise.allSettled(closing);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(`Queue close failed: ${String(result.reason)}`);
      }
    }
    this.queues.clear();
  }
}
