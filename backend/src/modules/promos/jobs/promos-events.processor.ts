import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import { EventsService } from '../services/events.service';
import { PromosService } from '../services/promos.service';
import { type PromosJobOutcome, handlePromosEventsJob } from './promos-events.handlers';

/**
 * BullMQ wiring for QUEUES.promosEvents: outbox events voucher.redeemed / voucher.cancelled
 * (job name = event type) and the hourly `promos-finish-events` schedule. Logic lives in
 * promos-events.handlers.ts (unit tested).
 */
@Processor(QUEUES.promosEvents, { concurrency: 2 })
export class PromosEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(PromosEventsProcessor.name);

  constructor(
    private readonly promos: PromosService,
    private readonly events: EventsService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async process(job: Job): Promise<PromosJobOutcome> {
    const outcome = await handlePromosEventsJob(job.name, job.data, {
      now: () => this.clock.now(),
      markRegistrationUsed: (voucherId) => this.events.markRegistrationUsedByVoucher(voucherId),
      cancelRegistrationByVoucher: (voucherId, reason) =>
        this.events.cancelRegistrationByVoucher(voucherId, reason),
      cancelCouponClaim: (claimId) => this.promos.cancelCouponClaim(claimId),
      finishDueEvents: (now) => this.events.finishDueEvents(now),
    });
    this.logger.log(`${outcome.job}: ${outcome.action}`);
    return outcome;
  }
}
