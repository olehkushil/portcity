import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import { RECEIPTS_CONFIG, type ReceiptsConfig } from '../receipts.config';
import { ReceiptPipelineService } from '../services/receipt-pipeline.service';
import { ReceiptProcessQueue } from '../services/receipt-process.queue';
import { ReceiptVerificationService } from '../services/receipt-verification.service';
import { ReceiptsRepository } from '../services/receipts.repository';
import {
  RECEIPTS_SWEEP_BATCH,
  type ReceiptsProcessJobResult,
  UNFINISHED_RECEIPT_STATUSES,
  handleReceiptsProcessJob,
} from './receipts-process.job';

/** BullMQ wiring only; the logic lives in receipts-process.job.ts (unit tested). */
@Processor(QUEUES.receiptsProcess, { concurrency: 2 })
export class ReceiptsProcessProcessor extends WorkerHost {
  private readonly logger = new Logger(ReceiptsProcessProcessor.name);

  constructor(
    private readonly pipeline: ReceiptPipelineService,
    private readonly queue: ReceiptProcessQueue,
    private readonly repo: ReceiptsRepository,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(RECEIPTS_CONFIG) private readonly config: ReceiptsConfig,
    private readonly verification: ReceiptVerificationService,
  ) {
    super();
  }

  async process(job: Job): Promise<ReceiptsProcessJobResult> {
    return handleReceiptsProcessJob(
      { name: job.name, data: job.data as unknown },
      {
        process: async (receiptId) => ({
          status: (await this.pipeline.process(receiptId)).receipt.status,
        }),
        findStuck: () =>
          this.repo.listStuck(
            this.prisma,
            UNFINISHED_RECEIPT_STATUSES,
            new Date(this.clock.nowMs() - this.config.RECEIPTS_STUCK_AFTER_MINUTES * 60_000),
            RECEIPTS_SWEEP_BATCH,
          ),
        enqueue: (receiptId, tag) => this.queue.enqueue(receiptId, tag),
        verifyHeld: () => this.verification.verifyHeld(),
        now: () => this.clock.now(),
        log: (message) => this.logger.log(message),
      },
    );
  }
}
