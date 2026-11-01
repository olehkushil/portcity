import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import { PAYMENT_EVENTS } from '../../../common/contracts/events';
import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import { ParkingErasureService } from '../services/parking-erasure.service';
import { ParkingPaymentsService } from '../services/parking-payments.service';
import { PAYMENT_SUCCEEDED_RETRY, runWithLongRetry } from './long-retry';
import { type ParkingEventOutcome, handleParkingEvent } from './parking-events.handler';

/**
 * BullMQ wiring only; the logic lives in parking-events.handler.ts (unit tested).
 * `payment.succeeded` runs under the long retry policy (long-retry.ts).
 */
@Processor(QUEUES.parkingEvents, { concurrency: 4 })
export class ParkingEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(ParkingEventsProcessor.name);

  constructor(
    private readonly payments: ParkingPaymentsService,
    private readonly erasure: ParkingErasureService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async process(job: Job<OutboxJobData>, token?: string): Promise<ParkingEventOutcome> {
    const handle = (): Promise<ParkingEventOutcome> =>
      handleParkingEvent(job.data, {
        applyPaymentSucceeded: (payload) => this.payments.applyPaymentSucceeded(payload),
        eraseUser: (userId) => this.erasure.eraseUser(userId),
      });
    if (job.name !== PAYMENT_EVENTS.succeeded) {
      return handle();
    }
    return runWithLongRetry(job, token, handle, {
      policy: PAYMENT_SUCCEEDED_RETRY,
      now: () => this.clock.nowMs(),
      delayedError: () => new DelayedError(),
      log: (message) => this.logger.warn(`payment.succeeded ${job.data.eventId}: ${message}`),
    });
  }
}
