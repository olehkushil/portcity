import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { QUEUES } from '../../../common/queue/queue.constants';
import { PaymentsErasureService } from '../services/payments-erasure.service';
import { type PaymentsEventOutcome, handlePaymentsEvent } from './payments-events.handler';

/** BullMQ wiring only; the logic lives in payments-events.handler.ts (unit tested). */
@Processor(QUEUES.paymentsEvents, { concurrency: 2 })
export class PaymentsEventsProcessor extends WorkerHost {
  constructor(private readonly erasure: PaymentsErasureService) {
    super();
  }

  async process(job: Job<OutboxJobData>): Promise<PaymentsEventOutcome> {
    return handlePaymentsEvent(job.data, {
      eraseUser: (userId) => this.erasure.eraseUser(userId),
    });
  }
}
