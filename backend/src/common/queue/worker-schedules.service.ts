import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import { KYIV_TZ } from '../time/kyiv';
import { QueueRegistry } from './queue-registry.service';

export interface ScheduleDefinition {
  /** Stable scheduler id (BullMQ job scheduler key), e.g. `points-expire-daily`. */
  id: string;
  queue: string;
  jobName: string;
  /** Interval in milliseconds; mutually exclusive with `pattern`. */
  every?: number;
  /** Cron pattern (5 fields); evaluated in `tz` (default Europe/Kyiv). */
  pattern?: string;
  tz?: string;
  data?: Record<string, unknown>;
  opts?: JobsOptions;
}

/**
 * Registry of repeatable jobs. Modules call `register()` in `onModuleInit`;
 * the worker entrypoint calls `apply()` after processors are registered.
 */
@Injectable()
export class WorkerSchedules {
  private readonly logger = new Logger(WorkerSchedules.name);
  private readonly definitions = new Map<string, ScheduleDefinition>();

  register(definition: ScheduleDefinition): void {
    const hasEvery = definition.every !== undefined;
    const hasPattern = definition.pattern !== undefined;
    if (hasEvery === hasPattern) {
      throw new Error(
        `Schedule "${definition.id}" must define exactly one of "every" or "pattern"`,
      );
    }
    if (hasEvery && (!Number.isInteger(definition.every) || (definition.every ?? 0) < 1000)) {
      throw new Error(`Schedule "${definition.id}": "every" must be an integer >= 1000 ms`);
    }
    const existing = this.definitions.get(definition.id);
    if (existing && existing.queue !== definition.queue) {
      throw new Error(
        `Schedule id "${definition.id}" is already registered for queue "${existing.queue}"`,
      );
    }
    this.definitions.set(definition.id, definition);
  }

  list(): ScheduleDefinition[] {
    return [...this.definitions.values()];
  }

  /** Upserts every schedule into its queue. Returns the number applied. */
  async apply(registry: QueueRegistry): Promise<number> {
    let applied = 0;
    for (const definition of this.definitions.values()) {
      const queue = registry.get(definition.queue);
      const repeat =
        definition.every !== undefined
          ? { every: definition.every }
          : { pattern: definition.pattern ?? '', tz: definition.tz ?? KYIV_TZ };
      await queue.upsertJobScheduler(definition.id, repeat, {
        name: definition.jobName,
        data: definition.data ?? {},
        opts: definition.opts ?? { removeOnComplete: 50, removeOnFail: 200 },
      });
      applied += 1;
      this.logger.log(
        `Schedule "${definition.id}" -> ${definition.queue}/${definition.jobName} (${
          definition.every !== undefined
            ? `every ${definition.every} ms`
            : `cron ${definition.pattern}`
        })`,
      );
    }
    return applied;
  }
}
