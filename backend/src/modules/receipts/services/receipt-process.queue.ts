import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import {
  RECEIPTS_PROCESS_JOBS,
  RECEIPTS_PROCESS_JOB_OPTIONS,
  receiptJobId,
} from '../jobs/receipts-process.job';

/** Producer side of a BullMQ Queue or the in-memory stand-in (QUEUE_DRIVER=memory). */
export interface ReceiptsQueueLike {
  add(name: string, data: { receiptId: string }, opts?: JobsOptions): Promise<unknown>;
}

/** Enqueues `receipts-process` jobs (owned queue, brief section 9). */
@Injectable()
export class ReceiptProcessQueue {
  private readonly logger = new Logger(ReceiptProcessQueue.name);

  constructor(@InjectQueue(QUEUES.receiptsProcess) private readonly queue: ReceiptsQueueLike) {}

  async enqueue(receiptId: string, tag: string): Promise<void> {
    await this.queue.add(
      RECEIPTS_PROCESS_JOBS.process,
      { receiptId },
      { ...RECEIPTS_PROCESS_JOB_OPTIONS, jobId: receiptJobId(receiptId, tag) },
    );
  }

  /** Never throws: a failed enqueue is logged and left to the periodic sweep. */
  async enqueueSafely(receiptId: string, tag: string): Promise<boolean> {
    try {
      await this.enqueue(receiptId, tag);
      return true;
    } catch (error) {
      this.logger.error(
        `Could not enqueue receipts-process for ${receiptId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
