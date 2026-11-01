import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../../common/queue/queue.constants';
import { Clock } from '../../../common/time/clock';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments.config';
import { PaymentsService } from '../services/payments.service';
import { PAYMENT_JOBS } from './job-names';
import { runAutoRefundJob, runFiscalizeJob, runPaymentsReconcile } from './payments-reconcile.job';

/** BullMQ wiring only; the logic lives in payments-reconcile.job.ts (unit tested). */
@Processor(QUEUES.paymentsReconcile, { concurrency: 1 })
export class PaymentsReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentsReconcileProcessor.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly clock: Clock,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case PAYMENT_JOBS.reconcile:
        return runPaymentsReconcile({
          now: () => this.clock.now(),
          timeoutMinutes: this.config.PAYMENTS_PENDING_TIMEOUT_MINUTES,
          batchSize: this.config.PAYMENTS_RECONCILE_BATCH,
          findStaleOpenPayments: (olderThan, limit) =>
            this.payments.findStaleOpenPayments(olderThan, limit),
          reconcilePayment: (paymentId) => this.payments.reconcilePayment(paymentId),
          fiscalizationEnabled: this.payments.fiscalizationEnabled,
          findUnfiscalized: (limit) => this.payments.findUnfiscalized(limit),
          enqueueFiscalize: (paymentId) => this.payments.enqueueFiscalize(paymentId),
          findQueuedAutoRefunds: (limit) => this.payments.findQueuedAutoRefunds(limit),
          enqueueAutoRefund: (paymentId, suffix) =>
            this.payments.enqueueAutoRefund(paymentId, suffix),
          log: (message) => this.logger.log(message),
        });
      case PAYMENT_JOBS.fiscalize:
        return runFiscalizeJob(job.data, {
          fiscalize: (paymentId) => this.payments.fiscalize(paymentId),
        });
      case PAYMENT_JOBS.autoRefund:
        return runAutoRefundJob(job.data, {
          runAutoRefund: (paymentId) => this.payments.runAutoRefund(paymentId),
        });
      default:
        throw new Error(`Unknown payments job "${job.name}"`);
    }
  }
}
