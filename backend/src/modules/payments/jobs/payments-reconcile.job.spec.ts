import type { PaymentSummary } from '../../../common/contracts/payments';
import type { ReconcileOutcome } from '../services/payments.service';
import {
  type ReconcileJobDeps,
  isFiscalizeJobData,
  runAutoRefundJob,
  runFiscalizeJob,
  runPaymentsReconcile,
} from './payments-reconcile.job';

const NOW = new Date('2026-01-15T10:00:00.000Z');

const summary = { id: 'p', status: 'expired' } as unknown as PaymentSummary;

function outcome(action: ReconcileOutcome['action']): ReconcileOutcome {
  if (action === 'skipped') {
    return { action, reason: 'provider_unavailable', payment: summary };
  }
  return {
    action,
    outcome: {
      kind: 'transitioned',
      paymentId: 'p',
      from: 'pending',
      to: 'expired',
      payment: summary,
    },
    payment: summary,
  };
}

function deps(overrides: Partial<ReconcileJobDeps> = {}): ReconcileJobDeps & {
  calls: string[];
  logs: string[];
} {
  const calls: string[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    now: () => NOW,
    timeoutMinutes: 20,
    batchSize: 50,
    findStaleOpenPayments: async (olderThan, limit) => {
      calls.push(`find:${olderThan.toISOString()}:${limit}`);
      return ['a', 'b', 'c', 'd'];
    },
    reconcilePayment: async (id) => {
      calls.push(`reconcile:${id}`);
      switch (id) {
        case 'a':
          return outcome('applied');
        case 'b':
          return outcome('expired');
        case 'c':
          throw new Error('provider exploded');
        default:
          return outcome('skipped');
      }
    },
    fiscalizationEnabled: false,
    findUnfiscalized: async (limit) => {
      calls.push(`unfiscalized:${limit}`);
      return ['x', 'y'];
    },
    enqueueFiscalize: async (id) => {
      calls.push(`enqueue:${id}`);
    },
    log: (message) => {
      logs.push(message);
    },
    ...overrides,
  };
}

describe('runPaymentsReconcile', () => {
  it('inspects payments older than the timeout and counts every outcome', async () => {
    const d = deps();
    const result = await runPaymentsReconcile(d);
    expect(result).toEqual({
      scanned: 4,
      applied: 1,
      expired: 1,
      skipped: 1,
      failed: 1,
      fiscalizeEnqueued: 0,
      autoRefundsRequeued: 0,
    });
    expect(d.calls).toEqual([
      'find:2026-01-15T09:40:00.000Z:50',
      'reconcile:a',
      'reconcile:b',
      'reconcile:c',
      'reconcile:d',
    ]);
    expect(d.logs.some((line) => line.includes('payment c failed: provider exploded'))).toBe(true);
    expect(d.logs.at(-1)).toContain('scanned 4, applied 1, expired 1, skipped 1, failed 1');
  });

  it('re-enqueues unfiscalised payments only when fiscalisation is enabled', async () => {
    const d = deps({ fiscalizationEnabled: true, findStaleOpenPayments: async () => [] });
    const result = await runPaymentsReconcile(d);
    expect(result).toMatchObject({ scanned: 0, fiscalizeEnqueued: 2 });
    expect(d.calls).toEqual(['unfiscalized:50', 'enqueue:x', 'enqueue:y']);
  });

  it('re-queues automatic refunds that are still queued, with an hourly job id suffix', async () => {
    const d = deps({
      findStaleOpenPayments: async () => [],
      findQueuedAutoRefunds: async (limit) => {
        d.calls.push(`queued-refunds:${limit}`);
        return ['r1'];
      },
      enqueueAutoRefund: async (id, suffix) => {
        d.calls.push(`refund:${id}:${suffix}`);
      },
    });
    const result = await runPaymentsReconcile(d);
    expect(result.autoRefundsRequeued).toBe(1);
    expect(d.calls).toEqual(['queued-refunds:50', 'refund:r1:2026011510']);
  });

  it('works without a logger', async () => {
    const d = deps({ log: undefined, findStaleOpenPayments: async () => ['c'] });
    await expect(runPaymentsReconcile(d)).resolves.toMatchObject({ failed: 1 });
  });
});

describe('runAutoRefundJob', () => {
  it('validates the payload and delegates', async () => {
    const runAutoRefund = jest
      .fn()
      .mockResolvedValue({ kind: 'refunded', paymentId: 'p', status: 'refunded' });
    await expect(runAutoRefundJob({ paymentId: 'p' }, { runAutoRefund })).resolves.toMatchObject({
      kind: 'refunded',
    });
    expect(runAutoRefund).toHaveBeenCalledWith('p');
    await expect(runAutoRefundJob({}, { runAutoRefund })).rejects.toThrow(
      'auto-refund job data must be { paymentId: string }',
    );
  });
});

describe('runFiscalizeJob', () => {
  it('validates the payload and delegates', async () => {
    const fiscalize = jest.fn().mockResolvedValue({ kind: 'skipped', paymentId: 'p', reason: 'x' });
    await expect(runFiscalizeJob({ paymentId: 'p' }, { fiscalize })).resolves.toEqual({
      kind: 'skipped',
      paymentId: 'p',
      reason: 'x',
    });
    expect(fiscalize).toHaveBeenCalledWith('p');
    await expect(runFiscalizeJob({ paymentId: '' }, { fiscalize })).rejects.toThrow(
      'fiscalize job data must be { paymentId: string }',
    );
    await expect(runFiscalizeJob(null, { fiscalize })).rejects.toThrow();
    expect(isFiscalizeJobData({ paymentId: 'p' })).toBe(true);
    expect(isFiscalizeJobData({ paymentId: 1 })).toBe(false);
  });
});
