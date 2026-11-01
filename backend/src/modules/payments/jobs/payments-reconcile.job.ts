import type {
  AutoRefundOutcome,
  FiscalizeOutcome,
  ReconcileOutcome,
} from '../services/payments.service';
import type { AutoRefundJobData, FiscalizeJobData } from './job-names';

export interface ReconcileJobDeps {
  now(): Date;
  /** Open payments older than this many minutes are inspected. */
  timeoutMinutes: number;
  batchSize: number;
  findStaleOpenPayments(olderThan: Date, limit: number): Promise<string[]>;
  reconcilePayment(paymentId: string): Promise<ReconcileOutcome>;
  fiscalizationEnabled: boolean;
  findUnfiscalized(limit: number): Promise<string[]>;
  enqueueFiscalize(paymentId: string): Promise<void>;
  /** Automatic refunds still `queued` (their job may have failed for good or never been added). */
  findQueuedAutoRefunds?(limit: number): Promise<string[]>;
  /** `jobSuffix` makes a fresh job id so BullMQ does not drop the re-queued job as a duplicate. */
  enqueueAutoRefund?(paymentId: string, jobSuffix: string): Promise<void>;
  log?: (message: string) => void;
}

export interface ReconcileJobSummary {
  scanned: number;
  applied: number;
  expired: number;
  skipped: number;
  failed: number;
  fiscalizeEnqueued: number;
  autoRefundsRequeued: number;
}

/**
 * Handler logic of the hourly `payments-reconcile` job (brief section 9): pending payments
 * older than the timeout are queried at the provider or expired; succeeded payments still
 * missing a fiscal receipt are re-queued for the fiscalisation hook. One failing payment
 * never stops the batch. Plain function: the processor only wires it.
 */
export async function runPaymentsReconcile(deps: ReconcileJobDeps): Promise<ReconcileJobSummary> {
  const summary: ReconcileJobSummary = {
    scanned: 0,
    applied: 0,
    expired: 0,
    skipped: 0,
    failed: 0,
    fiscalizeEnqueued: 0,
    autoRefundsRequeued: 0,
  };
  const olderThan = new Date(deps.now().getTime() - deps.timeoutMinutes * 60_000);
  const ids = await deps.findStaleOpenPayments(olderThan, deps.batchSize);
  summary.scanned = ids.length;

  for (const paymentId of ids) {
    try {
      const outcome = await deps.reconcilePayment(paymentId);
      if (outcome.action === 'applied') {
        summary.applied += 1;
      } else if (outcome.action === 'expired') {
        summary.expired += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      summary.failed += 1;
      deps.log?.(
        `payments-reconcile: payment ${paymentId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (deps.fiscalizationEnabled) {
    const pending = await deps.findUnfiscalized(deps.batchSize);
    for (const paymentId of pending) {
      await deps.enqueueFiscalize(paymentId);
      summary.fiscalizeEnqueued += 1;
    }
  }

  if (deps.findQueuedAutoRefunds && deps.enqueueAutoRefund) {
    const hour = deps.now().toISOString().slice(0, 13).replace(/\D/g, '');
    for (const paymentId of await deps.findQueuedAutoRefunds(deps.batchSize)) {
      await deps.enqueueAutoRefund(paymentId, hour);
      summary.autoRefundsRequeued += 1;
    }
  }

  deps.log?.(
    `payments-reconcile: scanned ${summary.scanned}, applied ${summary.applied}, expired ${summary.expired}, skipped ${summary.skipped}, failed ${summary.failed}, fiscalize enqueued ${summary.fiscalizeEnqueued}, auto refunds re-queued ${summary.autoRefundsRequeued}`,
  );
  return summary;
}

export interface AutoRefundJobDeps {
  runAutoRefund(paymentId: string): Promise<AutoRefundOutcome>;
}

export function isAutoRefundJobData(value: unknown): value is AutoRefundJobData {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { paymentId?: unknown }).paymentId === 'string' &&
    (value as { paymentId: string }).paymentId.length > 0
  );
}

/** Handler logic of the `auto-refund` job (long retry policy set when the job is added). */
export async function runAutoRefundJob(
  data: unknown,
  deps: AutoRefundJobDeps,
): Promise<AutoRefundOutcome> {
  if (!isAutoRefundJobData(data)) {
    throw new Error('auto-refund job data must be { paymentId: string }');
  }
  return deps.runAutoRefund(data.paymentId);
}

export interface FiscalizeJobDeps {
  fiscalize(paymentId: string): Promise<FiscalizeOutcome>;
}

export function isFiscalizeJobData(value: unknown): value is FiscalizeJobData {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { paymentId?: unknown }).paymentId === 'string' &&
    (value as { paymentId: string }).paymentId.length > 0
  );
}

/** Handler logic of the `fiscalize` job: validates the payload and delegates to the service. */
export async function runFiscalizeJob(
  data: unknown,
  deps: FiscalizeJobDeps,
): Promise<FiscalizeOutcome> {
  if (!isFiscalizeJobData(data)) {
    throw new Error('fiscalize job data must be { paymentId: string }');
  }
  return deps.fiscalize(data.paymentId);
}
