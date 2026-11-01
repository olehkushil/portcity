/**
 * Logic of the `receipts-process` queue (brief section 9: parse -> rules -> credit, retries 3
 * with backoff). The processor class only wires these plain functions; they are unit tested.
 *
 * Jobs:
 * - `process` `{ receiptId }`: drives one receipt through ReceiptPipelineService.process()
 *   (uploaded -> parsed -> decision -> credited). Enqueued when the synchronous attempt during
 *   submission or approval fails; a thrown error makes BullMQ retry (3 attempts, exponential
 *   backoff from 5 s).
 * - `sweep` (every 10 minutes): re-enqueues receipts stuck in parsed / auto_approved / approved,
 *   e.g. after all three attempts failed while the ledger was unavailable.
 * - `verify-held` (every 30 minutes): asks TaxReceiptVerifierPort about credited QR receipts in
 *   their verification hold; a rejection reverses the pending points through the ledger.
 */
import type { JobsOptions } from 'bullmq';
import type { ReceiptStatus } from '../../../common/contracts/receipts';
import { DomainError } from '../../../common/errors/domain-error';
import { ReceiptErrors } from '../domain/errors';

export const RECEIPTS_PROCESS_JOBS = {
  process: 'process',
  sweep: 'sweep',
  verifyHeld: 'verify-held',
} as const;
export type ReceiptsProcessJobName =
  (typeof RECEIPTS_PROCESS_JOBS)[keyof typeof RECEIPTS_PROCESS_JOBS];

/** Retry policy of `process` jobs (brief: retries 3 with backoff). */
export const RECEIPTS_PROCESS_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 1_000, age: 24 * 3_600 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 3_600 },
});

export const RECEIPTS_SWEEP_SCHEDULE_ID = 'receipts-process-sweep';
export const RECEIPTS_SWEEP_EVERY_MS = 10 * 60_000;
export const RECEIPTS_SWEEP_BATCH = 100;
export const RECEIPTS_VERIFY_SCHEDULE_ID = 'receipts-verify-held';
export const RECEIPTS_VERIFY_EVERY_MS = 30 * 60_000;

/** Statuses the pipeline still has to move forward. */
export const UNFINISHED_RECEIPT_STATUSES: readonly ReceiptStatus[] = Object.freeze([
  'uploaded',
  'parsed',
  'auto_approved',
  'approved',
]);

export interface ReceiptsProcessJobData {
  receiptId?: unknown;
}

/**
 * BullMQ job ids must not contain ":"; a tag keeps a re-enqueue (approval, sweep) from being
 * swallowed by a completed job with the same id that is still retained.
 */
export function receiptJobId(receiptId: string, tag: string): string {
  return `receipt-${receiptId}-${tag}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

export interface ReceiptsProcessDeps {
  /** ReceiptPipelineService.process(); throws on failure so the job is retried. */
  process(receiptId: string): Promise<{ status: ReceiptStatus }>;
  findStuck(): Promise<Array<{ id: string; status: ReceiptStatus }>>;
  enqueue(receiptId: string, tag: string): Promise<void>;
  /** ReceiptVerificationService.verifyHeld(). */
  verifyHeld(): Promise<VerifyHeldCounts>;
  now(): Date;
  log?(message: string): void;
}

export interface VerifyHeldCounts {
  checked: number;
  confirmed: number;
  rejected: number;
  unconfirmed: number;
}

export type ReceiptsProcessJobResult =
  | { kind: 'processed'; receiptId: string; status: ReceiptStatus }
  | { kind: 'skipped'; reason: 'invalid_payload' | 'not_found' }
  | { kind: 'swept'; enqueued: number }
  | ({ kind: 'verified' } & VerifyHeldCounts);

const RECEIPT_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

export function readReceiptId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const value = (data as ReceiptsProcessJobData).receiptId;
  return typeof value === 'string' && RECEIPT_ID_PATTERN.test(value) ? value : null;
}

export async function handleReceiptsProcessJob(
  job: { name: string; data: unknown },
  deps: ReceiptsProcessDeps,
): Promise<ReceiptsProcessJobResult> {
  switch (job.name) {
    case RECEIPTS_PROCESS_JOBS.process: {
      const receiptId = readReceiptId(job.data);
      if (receiptId === null) {
        deps.log?.(`receipts-process: skipped a job without a valid receiptId`);
        return { kind: 'skipped', reason: 'invalid_payload' };
      }
      try {
        const { status } = await deps.process(receiptId);
        return { kind: 'processed', receiptId, status };
      } catch (error) {
        if (DomainError.is(error) && error.code === ReceiptErrors.PC_RECEIPT_NOT_FOUND) {
          deps.log?.(`receipts-process: receipt ${receiptId} no longer exists`);
          return { kind: 'skipped', reason: 'not_found' };
        }
        throw error;
      }
    }
    case RECEIPTS_PROCESS_JOBS.sweep: {
      const stuck = await deps.findStuck();
      const bucket = Math.floor(deps.now().getTime() / RECEIPTS_SWEEP_EVERY_MS);
      for (const row of stuck) {
        await deps.enqueue(row.id, `sweep-${bucket}`);
      }
      if (stuck.length > 0) {
        deps.log?.(`receipts-process: re-enqueued ${stuck.length} unfinished receipt(s)`);
      }
      return { kind: 'swept', enqueued: stuck.length };
    }
    case RECEIPTS_PROCESS_JOBS.verifyHeld: {
      const counts = await deps.verifyHeld();
      return { kind: 'verified', ...counts };
    }
    default:
      throw new Error(`Unknown receipts-process job "${job.name}"`);
  }
}
