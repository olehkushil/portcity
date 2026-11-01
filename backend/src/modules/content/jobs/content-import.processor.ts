import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { ContentImportService } from '../services/content-import.service';
import {
  type ContentImportJobResult,
  handleContentImportQueueJob,
} from './content-import-queue.job';

/** BullMQ wiring only; the logic lives in content-import-queue.job.ts (unit tested). */
@Processor(QUEUES.contentImport, { concurrency: 1 })
export class ContentImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ContentImportProcessor.name);

  constructor(private readonly imports: ContentImportService) {
    super();
  }

  async process(job: Job): Promise<ContentImportJobResult> {
    return handleContentImportQueueJob(job.name, job.data, {
      execute: (data) => this.imports.executeQueued(data),
      log: (message) => this.logger.log(message),
    });
  }
}
