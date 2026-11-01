import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { VoucherService } from '../services/voucher.service';
import { type RewardsEventOutcome, handleRewardsEventJob } from './rewards-events.handler';

/** BullMQ wiring only; the logic lives in rewards-events.handler.ts (unit tested). */
@Processor(QUEUES.rewardsEvents, { concurrency: 2 })
export class RewardsEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(RewardsEventsProcessor.name);

  constructor(private readonly vouchers: VoucherService) {
    super();
  }

  async process(job: Job): Promise<RewardsEventOutcome> {
    return handleRewardsEventJob(job.name, job.data, {
      cancelVoucher: (voucherId, reason, refundPoints) =>
        this.vouchers.cancelBySystem(voucherId, reason, refundPoints),
      cancelLiveVouchers: (filter, reason, refundPoints) =>
        this.vouchers.cancelLiveVouchers(filter, reason, refundPoints),
      log: (message) => this.logger.log(message),
    });
  }
}
