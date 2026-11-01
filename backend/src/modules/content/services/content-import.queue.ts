import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import {
  CONTENT_IMPORT_JOBS,
  CONTENT_IMPORT_JOB_OPTIONS,
  type ContentImportJobData,
  contentImportJobId,
} from '../jobs/content-import-queue.job';

/** Producer side of a BullMQ Queue or the in-memory stand-in (QUEUE_DRIVER=memory). */
export interface ContentImportQueueLike {
  add(name: string, data: ContentImportJobData, opts?: JobsOptions): Promise<unknown>;
}

/** Enqueues `content-import` jobs (queue owned by content). */
@Injectable()
export class ContentImportQueue {
  constructor(@InjectQueue(QUEUES.contentImport) private readonly queue: ContentImportQueueLike) {}

  async enqueue(data: ContentImportJobData): Promise<void> {
    await this.queue.add(CONTENT_IMPORT_JOBS.run, data, {
      ...CONTENT_IMPORT_JOB_OPTIONS,
      jobId: contentImportJobId(data.runId),
    });
  }
}
