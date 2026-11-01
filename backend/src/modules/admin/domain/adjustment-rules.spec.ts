import {
  FOUR_EYES_THRESHOLD_POINTS,
  MANUAL_ADJUSTMENT_STATUSES,
  type ManualAdjustmentStatus,
} from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import {
  ADJUSTMENT_TRANSITIONS,
  MAX_ADJUSTMENT_POINTS,
  adjustmentIdempotencyKey,
  assertAdjustmentAmount,
  assertCanApply,
  assertCanApprove,
  assertCanReject,
  assertTransition,
  canTransition,
  isFinalAdjustmentStatus,
  isValidAdjustmentAmount,
  ledgerOperationFor,
  needsSecondApproval,
  type SecondApprovalReason,
  type SelfApprovedTotals,
  isSecondApprovalReason,
  planAdjustmentRequest,
  secondApprovalReasonFor,
  sumAbsolutePoints,
} from './adjustment-rules';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return DomainError.is(error) ? error.code : `not-a-domain-error: ${String(error)}`;
  }
}

describe('adjustment state machine', () => {
  const allowed: ReadonlyArray<[ManualAdjustmentStatus, ManualAdjustmentStatus]> = [
    ['pending', 'approved'],
    ['pending', 'rejected'],
    ['approved', 'applied'],
    ['approved', 'rejected'],
  ];

  const table: Array<[ManualAdjustmentStatus, ManualAdjustmentStatus, boolean]> = [];
  for (const from of MANUAL_ADJUSTMENT_STATUSES) {
    for (const to of MANUAL_ADJUSTMENT_STATUSES) {
      table.push([from, to, allowed.some(([a, b]) => a === from && b === to)]);
    }
  }

  it.each(table)('%s -> %s allowed: %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
    if (expected) {
      expect(() => assertTransition(from, to, 'adj-1')).not.toThrow();
    } else {
      expect(codeOf(() => assertTransition(from, to, 'adj-1'))).toBe(
        'PC_ADJUSTMENT_INVALID_TRANSITION',
      );
    }
  });

  it('declares applied and rejected as final', () => {
    expect(isFinalAdjustmentStatus('applied')).toBe(true);
    expect(isFinalAdjustmentStatus('rejected')).toBe(true);
    expect(isFinalAdjustmentStatus('pending')).toBe(false);
    expect(isFinalAdjustmentStatus('approved')).toBe(false);
    expect(ADJUSTMENT_TRANSITIONS.applied).toHaveLength(0);
    expect(ADJUSTMENT_TRANSITIONS.rejected).toHaveLength(0);
  });

  it('reports the allowed targets in the error details', () => {
    try {
      assertTransition('applied', 'approved', 'adj-9');
      throw new Error('expected a DomainError');
    } catch (error) {
      expect(DomainError.is(error)).toBe(true);
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).details).toEqual({
        adjustmentId: 'adj-9',
        from: 'applied',
        to: 'approved',
        allowed: [],
      });
    }
  });
});

describe('amount validation', () => {
  it.each<[unknown, boolean]>([
    [1, true],
    [-1, true],
    [500, true],
    [MAX_ADJUSTMENT_POINTS, true],
    [-MAX_ADJUSTMENT_POINTS, true],
    [0, false],
    [1.5, false],
    [-0.1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [MAX_ADJUSTMENT_POINTS + 1, false],
    ['100', false],
    [null, false],
    [undefined, false],
  ])('amount %p valid: %s', (amount, expected) => {
    expect(isValidAdjustmentAmount(amount)).toBe(expected);
    if (expected) {
      expect(() => assertAdjustmentAmount(amount)).not.toThrow();
    } else {
      expect(codeOf(() => assertAdjustmentAmount(amount))).toBe('PC_ADJUSTMENT_AMOUNT_INVALID');
    }
  });
});

describe('four-eyes threshold', () => {
  it.each<[number, number | undefined, boolean]>([
    [500, undefined, false],
    [-500, undefined, false],
    [501, undefined, true],
    [-501, undefined, true],
    [1, undefined, false],
    [100_000, undefined, true],
    [100, 50, true],
    [50, 50, false],
    [-51, 50, true],
  ])('amount %d with threshold %p needs a second approval: %s', (amount, threshold, expected) => {
    expect(needsSecondApproval(amount, threshold)).toBe(expected);
  });

  it('uses the contract threshold of 500 points by default', () => {
    expect(FOUR_EYES_THRESHOLD_POINTS).toBe(500);
    expect(needsSecondApproval(500)).toBe(false);
    expect(needsSecondApproval(501)).toBe(true);
  });
});

describe('planAdjustmentRequest', () => {
  it('lets the requester decide alone at or below the threshold', () => {
    expect(planAdjustmentRequest({ amount: 300, requestedById: 'admin-1' })).toEqual({
      needsSecondApproval: false,
      secondApprovalReason: null,
      initialStatus: 'approved',
      approvedById: 'admin-1',
      thresholdPoints: 500,
      totals: { requesterKyivDay: 300, account24h: 300 },
    });
  });

  it('keeps large adjustments pending for a second admin', () => {
    expect(planAdjustmentRequest({ amount: -800, requestedById: 'admin-1' })).toEqual({
      needsSecondApproval: true,
      secondApprovalReason: 'amount',
      initialStatus: 'pending',
      approvedById: null,
      thresholdPoints: 500,
      totals: { requesterKyivDay: 800, account24h: 800 },
    });
  });

  it('honours a custom threshold and rejects invalid amounts', () => {
    expect(
      planAdjustmentRequest({ amount: 120, requestedById: 'a', thresholdPoints: 100 }),
    ).toMatchObject({ needsSecondApproval: true, thresholdPoints: 100 });
    expect(codeOf(() => planAdjustmentRequest({ amount: 0, requestedById: 'a' }))).toBe(
      'PC_ADJUSTMENT_AMOUNT_INVALID',
    );
  });

  // Splitting a large correction into small self-approved parts must not bypass four eyes.
  it.each<[string, number, SelfApprovedTotals, SecondApprovalReason | null]>([
    ['first small part of the day', 300, { requesterKyivDay: 0, account24h: 0 }, null],
    ['exactly at the threshold', 200, { requesterKyivDay: 300, account24h: 300 }, null],
    [
      'second part over the daily total',
      300,
      { requesterKyivDay: 300, account24h: 0 },
      'requester_daily_total',
    ],
    [
      'debits count by absolute value',
      -250,
      { requesterKyivDay: 300, account24h: 0 },
      'requester_daily_total',
    ],
    [
      'same account by other admins in 24 h',
      100,
      { requesterKyivDay: 0, account24h: 450 },
      'account_24h_total',
    ],
    ['single large amount wins', 600, { requesterKyivDay: 0, account24h: 0 }, 'amount'],
  ])('%s', (_name, amount, selfApproved, reason) => {
    expect(secondApprovalReasonFor(amount, 500, selfApproved)).toBe(reason);
    const plan = planAdjustmentRequest({ amount, requestedById: 'admin-1', selfApproved });
    expect(plan).toMatchObject({
      needsSecondApproval: reason !== null,
      secondApprovalReason: reason,
      initialStatus: reason === null ? 'approved' : 'pending',
      approvedById: reason === null ? 'admin-1' : null,
    });
  });

  it('reports the totals including the new request and validates the reason vocabulary', () => {
    const plan = planAdjustmentRequest({
      amount: -120,
      requestedById: 'admin-1',
      selfApproved: { requesterKyivDay: 300, account24h: 50 },
    });
    expect(plan.totals).toEqual({ requesterKyivDay: 420, account24h: 170 });
    expect(sumAbsolutePoints([{ amount: 100 }, { amount: -40 }])).toBe(140);
    expect(isSecondApprovalReason('account_24h_total')).toBe(true);
    expect(isSecondApprovalReason('other')).toBe(false);
  });
});

describe('decision guards', () => {
  it.each<[ManualAdjustmentStatus, string, string, string | undefined]>([
    ['pending', 'admin-1', 'admin-2', undefined],
    ['pending', 'admin-1', 'admin-1', 'PC_ADJUSTMENT_SELF_APPROVAL'],
    ['approved', 'admin-1', 'admin-2', 'PC_ADJUSTMENT_INVALID_TRANSITION'],
    ['applied', 'admin-1', 'admin-2', 'PC_ADJUSTMENT_INVALID_TRANSITION'],
    ['rejected', 'admin-1', 'admin-2', 'PC_ADJUSTMENT_INVALID_TRANSITION'],
  ])(
    'approve from %s requested by %s approver %s -> %p',
    (status, requestedById, approverId, code) => {
      expect(
        codeOf(() =>
          assertCanApprove({ adjustmentId: 'adj-1', status, requestedById, approverId }),
        ),
      ).toBe(code);
    },
  );

  it.each<[ManualAdjustmentStatus, string | undefined]>([
    ['approved', undefined],
    ['pending', 'PC_ADJUSTMENT_APPROVAL_REQUIRED'],
    ['applied', 'PC_ADJUSTMENT_INVALID_TRANSITION'],
    ['rejected', 'PC_ADJUSTMENT_INVALID_TRANSITION'],
  ])('apply from %s -> %p', (status, code) => {
    expect(codeOf(() => assertCanApply('adj-1', status))).toBe(code);
  });

  it.each<[ManualAdjustmentStatus, string | undefined]>([
    ['pending', undefined],
    ['approved', undefined],
    ['applied', 'PC_ADJUSTMENT_INVALID_TRANSITION'],
    ['rejected', 'PC_ADJUSTMENT_INVALID_TRANSITION'],
  ])('reject from %s -> %p', (status, code) => {
    expect(codeOf(() => assertCanReject('adj-1', status))).toBe(code);
  });
});

describe('ledger mapping', () => {
  it('credits positive and spends negative amounts with positive magnitudes', () => {
    expect(ledgerOperationFor(250)).toEqual({ kind: 'credit', amount: 250 });
    expect(ledgerOperationFor(-40)).toEqual({ kind: 'spend', amount: 40 });
    expect(codeOf(() => ledgerOperationFor(0))).toBe('PC_ADJUSTMENT_AMOUNT_INVALID');
  });

  it('derives one stable idempotency key per adjustment', () => {
    expect(adjustmentIdempotencyKey('0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11')).toBe(
      'adjustment:0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
    );
  });
});
