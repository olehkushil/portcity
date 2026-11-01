import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { QUEUES } from '../../../common/queue/queue.constants';
import { StoragePort } from '../../../common/storage/storage.port';
import { ReceiptsRepository } from '../services/receipts.repository';
import { type ReceiptsEventOutcome, handleReceiptsEventJob } from './receipts-events.handler';

/** BullMQ wiring only; the logic lives in receipts-events.handler.ts (unit tested). */
@Processor(QUEUES.receiptsEvents, { concurrency: 2 })
export class ReceiptsEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(ReceiptsEventsProcessor.name);

  constructor(
    private readonly repo: ReceiptsRepository,
    private readonly prisma: PrismaService,
    private readonly storage: StoragePort,
  ) {
    super();
  }

  async process(job: Job): Promise<ReceiptsEventOutcome> {
    return handleReceiptsEventJob(job.name, job.data, {
      listPhotoKeys: (userId) => this.repo.listPhotoKeysForUser(this.prisma, userId),
      deletePhoto: (key) => this.storage.deleteObject(key),
      erase: (userId, placeholder) =>
        this.prisma.withTx((tx) => this.repo.erasePersonalData(tx, userId, placeholder)),
      log: (message) => this.logger.log(message),
    });
  }
}
