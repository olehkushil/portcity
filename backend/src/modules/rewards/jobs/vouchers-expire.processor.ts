import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import { REWARDS_CONFIG, type RewardsConfig } from '../rewards.config';
import { VoucherService } from '../services/voucher.service';
import { REWARDS_JOBS } from './job-names';
import { type VouchersExpireSummary, runVouchersExpire } from './vouchers-expire.job';

/** BullMQ wiring only; the logic lives in vouchers-expire.job.ts (unit tested). */
@Processor(QUEUES.vouchersExpire, { concurrency: 1 })
export class VouchersExpireProcessor extends WorkerHost {
  private readonly logger = new Logger(VouchersExpireProcessor.name);

  constructor(
    private readonly vouchers: VoucherService,
    private readonly clock: Clock,
    @Inject(REWARDS_CONFIG) private readonly config: RewardsConfig,
  ) {
    super();
  }

  async process(job: Job): Promise<VouchersExpireSummary> {
    if (job.name !== REWARDS_JOBS.expireVouchers) {
      throw new Error(`Unknown vouchers-expire job "${job.name}"`);
    }
    return runVouchersExpire({
      now: () => this.clock.now(),
      batchSize: this.config.REWARDS_SWEEP_BATCH_SIZE,
      findCandidates: (now, limit) => this.vouchers.findSweepCandidates(now, limit),
      apply: (voucher, action, now) => this.vouchers.applySweepAction(voucher, action, now),
      log: (message) => this.logger.log(message),
    });
  }
}
