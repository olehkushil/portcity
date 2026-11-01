import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { OutboxService } from '../outbox/outbox.service';
import { QUEUES } from '../queue/queue.constants';
import { Clock } from '../time/clock';
import { type MaintenanceOutcome, runMaintenanceJob } from './maintenance.jobs';

@Processor(QUEUES.maintenance, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async process(job: Job): Promise<MaintenanceOutcome> {
    const outcome = await runMaintenanceJob(job.name, {
      now: () => this.clock.now(),
      purgeExpiredIdempotencyKeys: (now) => this.idempotency.purgeExpired(now),
      purgePublishedOutboxEvents: (olderThan) => this.outbox.purgePublished(olderThan),
    });
    this.logger.log(`${outcome.job}: removed ${outcome.removed} rows`);
    return outcome;
  }
}
