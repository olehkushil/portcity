import {
  HARNESS_NOW,
  MEMBER,
  createReceiptsHarness,
  taxQr,
} from '../../../../test/receipts/support/receipts-harness';
import { DomainError } from '../../../common/errors/domain-error';
import { ReceiptErrors } from '../domain/errors';
import {
  RECEIPTS_PROCESS_JOBS,
  RECEIPTS_PROCESS_JOB_OPTIONS,
  RECEIPTS_SWEEP_EVERY_MS,
  type ReceiptsProcessDeps,
  UNFINISHED_RECEIPT_STATUSES,
  handleReceiptsProcessJob,
  readReceiptId,
  receiptJobId,
} from './receipts-process.job';

const RECEIPT_ID = '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11';

function deps(overrides: Partial<ReceiptsProcessDeps> = {}): ReceiptsProcessDeps {
  return {
    process: jest.fn(async () => ({ status: 'credited' as const })),
    findStuck: jest.fn(async () => []),
    enqueue: jest.fn(async () => undefined),
    verifyHeld: jest.fn(async () => ({ checked: 0, confirmed: 0, rejected: 0, unconfirmed: 0 })),
    now: () => new Date(HARNESS_NOW),
    log: jest.fn(),
    ...overrides,
  };
}

describe('receipts-process job', () => {
  it('retries 3 times with exponential backoff', () => {
    expect(RECEIPTS_PROCESS_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  });

  it('builds BullMQ-safe job ids', () => {
    expect(receiptJobId(RECEIPT_ID, 'submit')).toBe(`receipt-${RECEIPT_ID}-submit`);
    expect(receiptJobId(RECEIPT_ID, 'a:b c')).toBe(`receipt-${RECEIPT_ID}-a-b-c`);
  });

  it('reads only well-formed receipt ids from the payload', () => {
    expect(readReceiptId({ receiptId: RECEIPT_ID })).toBe(RECEIPT_ID);
    expect(readReceiptId({ receiptId: 42 })).toBeNull();
    expect(readReceiptId({ receiptId: 'abc' })).toBeNull();
    expect(readReceiptId(null)).toBeNull();
    expect(readReceiptId('x')).toBeNull();
  });

  it('process: drives the pipeline and reports the final status', async () => {
    const d = deps();
    await expect(
      handleReceiptsProcessJob(
        { name: RECEIPTS_PROCESS_JOBS.process, data: { receiptId: RECEIPT_ID } },
        d,
      ),
    ).resolves.toEqual({ kind: 'processed', receiptId: RECEIPT_ID, status: 'credited' });
    expect(d.process).toHaveBeenCalledWith(RECEIPT_ID);
  });

  it('process: skips a malformed payload without retrying', async () => {
    const d = deps();
    await expect(
      handleReceiptsProcessJob({ name: RECEIPTS_PROCESS_JOBS.process, data: {} }, d),
    ).resolves.toEqual({ kind: 'skipped', reason: 'invalid_payload' });
    expect(d.process).not.toHaveBeenCalled();
  });

  it('process: skips a receipt that no longer exists', async () => {
    const d = deps({
      process: jest.fn(async () => {
        throw new DomainError(ReceiptErrors.PC_RECEIPT_NOT_FOUND, 'gone');
      }),
    });
    await expect(
      handleReceiptsProcessJob(
        { name: RECEIPTS_PROCESS_JOBS.process, data: { receiptId: RECEIPT_ID } },
        d,
      ),
    ).resolves.toEqual({ kind: 'skipped', reason: 'not_found' });
  });

  it('process: rethrows other failures so BullMQ retries the job', async () => {
    const d = deps({
      process: jest.fn(async () => {
        throw new Error('ledger unavailable');
      }),
    });
    await expect(
      handleReceiptsProcessJob(
        { name: RECEIPTS_PROCESS_JOBS.process, data: { receiptId: RECEIPT_ID } },
        d,
      ),
    ).rejects.toThrow('ledger unavailable');
  });

  it('sweep: re-enqueues unfinished receipts with a per-interval tag', async () => {
    const d = deps({
      findStuck: jest.fn(async () => [
        { id: RECEIPT_ID, status: 'auto_approved' as const },
        { id: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e12', status: 'approved' as const },
      ]),
    });
    const bucket = Math.floor(new Date(HARNESS_NOW).getTime() / RECEIPTS_SWEEP_EVERY_MS);
    await expect(
      handleReceiptsProcessJob({ name: RECEIPTS_PROCESS_JOBS.sweep, data: {} }, d),
    ).resolves.toEqual({
      kind: 'swept',
      enqueued: 2,
    });
    expect(d.enqueue).toHaveBeenNthCalledWith(1, RECEIPT_ID, `sweep-${bucket}`);
    expect(d.enqueue).toHaveBeenCalledTimes(2);
  });

  it('verify-held: runs the verification pass and reports its counts', async () => {
    const d = deps({
      verifyHeld: jest.fn(async () => ({ checked: 3, confirmed: 1, rejected: 1, unconfirmed: 1 })),
    });
    await expect(
      handleReceiptsProcessJob({ name: RECEIPTS_PROCESS_JOBS.verifyHeld, data: {} }, d),
    ).resolves.toEqual({ kind: 'verified', checked: 3, confirmed: 1, rejected: 1, unconfirmed: 1 });
    expect(d.verifyHeld).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown job names', async () => {
    await expect(handleReceiptsProcessJob({ name: 'nope', data: {} }, deps())).rejects.toThrow(
      'Unknown receipts-process job "nope"',
    );
  });

  it('end to end with the fakes: a stuck auto-approved receipt is swept and credited once', async () => {
    const h = createReceiptsHarness();
    h.ledger.failNext('credit');
    const submitted = await h.submission.submitQr(
      MEMBER,
      taxQr({
        issuedAt: new Date(new Date(HARNESS_NOW).getTime() - 3_600_000),
        totalKopecks: 50_000,
      }),
    );
    expect(submitted.receipt.status).toBe('auto_approved');
    h.clock.advanceMinutes(10);

    const realDeps: ReceiptsProcessDeps = {
      process: async (receiptId) => ({
        status: (await h.pipeline.process(receiptId)).receipt.status,
      }),
      findStuck: () =>
        h.repo.listStuck(
          null,
          UNFINISHED_RECEIPT_STATUSES,
          new Date(h.clock.nowMs() - h.config.RECEIPTS_STUCK_AFTER_MINUTES * 60_000),
          100,
        ),
      enqueue: (receiptId, tag) => h.queue.enqueue(receiptId, tag),
      verifyHeld: () => h.verification.verifyHeld(),
      now: () => h.clock.now(),
    };

    const swept = await handleReceiptsProcessJob(
      { name: RECEIPTS_PROCESS_JOBS.sweep, data: {} },
      realDeps,
    );
    expect(swept).toEqual({ kind: 'swept', enqueued: 1 });
    const sweepJob = h.queueBackend.jobs.at(-1)!;
    expect(sweepJob.id).toMatch(new RegExp(`^receipt-${submitted.receipt.id}-sweep-\\d+$`));

    const processed = await handleReceiptsProcessJob(
      { name: sweepJob.name, data: sweepJob.data },
      realDeps,
    );
    expect(processed).toEqual({
      kind: 'processed',
      receiptId: submitted.receipt.id,
      status: 'credited',
    });
    // A late duplicate job is harmless.
    await handleReceiptsProcessJob({ name: sweepJob.name, data: sweepJob.data }, realDeps);
    expect(h.ledger.entries).toHaveLength(1);
  });
});
