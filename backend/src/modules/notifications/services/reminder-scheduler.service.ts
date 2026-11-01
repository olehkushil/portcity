import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InMemoryQueue } from '../../../common/queue/in-memory-queue';
import type { QueueHandle } from '../../../common/queue/queue-registry.service';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import type { ReminderRequest } from '../domain/reminders';

/**
 * Delayed reminder jobs on the notifications-events queue (ticket reminders, voucher expiry).
 * Stable job ids make scheduling idempotent and let terminal events cancel a pending reminder.
 */
@Injectable()
export class ReminderScheduler {
  private readonly logger = new Logger(ReminderScheduler.name);

  constructor(
    @InjectQueue(QUEUES.notificationsEvents) private readonly queue: QueueHandle,
    private readonly clock: Clock,
  ) {}

  /** False when `runAt` is already in the past (nothing scheduled). */
  async schedule(request: ReminderRequest): Promise<boolean> {
    const delay = request.runAt.getTime() - this.clock.now().getTime();
    if (delay <= 0) {
      return false;
    }
    await this.queue.add(request.jobName, request.data, {
      jobId: request.id,
      delay,
      removeOnComplete: true,
    });
    return true;
  }

  /** True when a pending job was removed; an already running or finished job is left alone. */
  async cancel(reminderId: string): Promise<boolean> {
    if (this.queue instanceof InMemoryQueue) {
      const index = this.queue.jobs.findIndex((job) => job.id === reminderId);
      if (index === -1) {
        return false;
      }
      this.queue.jobs.splice(index, 1);
      return true;
    }
    try {
      const job = await this.queue.getJob(reminderId);
      if (!job) {
        return false;
      }
      await job.remove();
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not cancel reminder ${reminderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
