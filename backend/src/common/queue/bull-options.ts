import type { QueueOptions } from 'bullmq';
import type { AppConfig } from '../config';

/** Shared BullMQ options derived from configuration (connection, prefix, retry policy). */
export function buildBullQueueOptions(
  config: Pick<AppConfig, 'REDIS_URL' | 'BULL_PREFIX'>,
): QueueOptions {
  return {
    connection: {
      url: config.REDIS_URL,
      // BullMQ requirement for blocking commands used by workers.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (attempt: number) => Math.min(attempt * 500, 5_000),
    },
    prefix: config.BULL_PREFIX,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { count: 1_000, age: 24 * 3_600 },
      removeOnFail: { count: 5_000, age: 7 * 24 * 3_600 },
    },
  };
}
