import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { StoragePort } from '../../../common/storage/storage.port';
import { SupportRequestsService } from '../services/support-requests.service';
import { type AdminEventOutcome, handleAdminEventJob } from './admin-events.handler';

/** BullMQ wiring only; the logic lives in admin-events.handler.ts (unit tested). */
@Processor(QUEUES.adminEvents, { concurrency: 2 })
export class AdminEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(AdminEventsProcessor.name);

  constructor(
    private readonly support: SupportRequestsService,
    private readonly storage: StoragePort,
  ) {
    super();
  }

  async process(job: Job): Promise<AdminEventOutcome> {
    return handleAdminEventJob(job.name, job.data, {
      listSupportPhotoKeys: (userId) => this.support.listPhotoKeysOfUser(userId),
      deletePhoto: (key) => this.storage.deleteObject(key),
      eraseSupportRequests: (userId, placeholder) =>
        this.support.eraseUserRequests(userId, placeholder),
      log: (message) => this.logger.log(message),
    });
  }
}
