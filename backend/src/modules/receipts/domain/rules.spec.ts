import { DEFAULT_LOYALTY_RULES, type LoyaltyRules } from '../../../common/contracts/club';
import {
  type ModerationReason,
  type ReceiptDecision,
  type ReceiptRuleInput,
  type RuleTenant,
  type VerificationHoldInput,
  assessRisk,
  buildCreditPlan,
  computePoints,
  describeDecision,
  effectiveRatePercent,
  evaluateReceipt,
  exceedsDailyQrCap,
  isFiscalIdOutOfOrder,
  isRoundTotal,
  isRoundTotalRepeat,
  minimumTotalKopecks,
  verificationHoldUntil,
} from './rules';

const NOW = new Date('2026-01-15T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TENANT: RuleTenant = {
  id: 'tenant-intertop',
  name: 'INTERTOP',
  participates: true,
  excludedFromProgram: false,
  ratePercentOverride: null,
};

function input(overrides: Partial<ReceiptRuleInput> = {}): ReceiptRuleInput {
  return {
    source: 'qr',
    fn: '4000100011',
    issuedAt: new Date(NOW.getTime() - HOUR),
    totalKopecks: 50_000,
    submittedAt: NOW,
    now: NOW,
    fiscalNumber: { status: 'active', tenantId: TENANT.id },
    tenant: TENANT,
    tenantRule: null,
    receiptsToday: 0,
    sameFnRecent: 0,
    deviceShared: false,
    rules: DEFAULT_LOYALTY_RULES,
    ...overrides,
  };
}

interface Expectation {
  kind: ReceiptDecision['kind'];
  code?: string;
  reasons?: ModerationReason[];
  flags?: string[];
  score?: number;
}

describe('evaluateReceipt', () => {
  const cases: Array<{
    name: string;
    overrides: Partial<ReceiptRuleInput>;
    expected: Expectation;
  }> = [
    {
      name: 'clean QR receipt from a whitelisted register is auto-approved',
      overrides: {},
      expected: { kind: 'auto_approved', flags: [], score: 0 },
    },
    {
      name: 'issued 11 minutes in the future -> PC_RECEIPT_FUTURE',
      overrides: { issuedAt: new Date(NOW.getTime() + 11 * MINUTE) },
      expected: { kind: 'rejected', code: 'PC_RECEIPT_FUTURE' },
    },
    {
      name: 'issued 9 minutes in the future is tolerated (clock skew)',
      overrides: { issuedAt: new Date(NOW.getTime() + 9 * MINUTE) },
      expected: { kind: 'auto_approved', flags: [] },
    },
    {
      name: 'issued 7 days and one minute ago -> PC_RECEIPT_TOO_OLD',
      overrides: { issuedAt: new Date(NOW.getTime() - 7 * DAY - MINUTE) },
      expected: { kind: 'rejected', code: 'PC_RECEIPT_TOO_OLD' },
    },
    {
      name: 'issued exactly 7 days ago is still inside the window',
      overrides: { issuedAt: new Date(NOW.getTime() - 7 * DAY) },
      expected: { kind: 'auto_approved' },
    },
    {
      name: 'excluded tenant -> PC_RECEIPT_EXCLUDED_TENANT',
      overrides: { tenant: { ...TENANT, excludedFromProgram: true } },
      expected: { kind: 'rejected', code: 'PC_RECEIPT_EXCLUDED_TENANT' },
    },
    {
      name: 'tenant that does not participate -> PC_RECEIPT_EXCLUDED_TENANT',
      overrides: { tenant: { ...TENANT, participates: false } },
      expected: { kind: 'rejected', code: 'PC_RECEIPT_EXCLUDED_TENANT' },
    },
    {
      name: 'future wins over excluded tenant (rejections are ordered)',
      overrides: {
        issuedAt: new Date(NOW.getTime() + DAY),
        tenant: { ...TENANT, excludedFromProgram: true },
      },
      expected: { kind: 'rejected', code: 'PC_RECEIPT_FUTURE' },
    },
    {
      name: 'total below the tenant minimum -> PC_RECEIPT_TOTAL_INVALID',
      overrides: {
        totalKopecks: 9_999,
        tenantRule: { ratePercent: null, minTotalKopecks: 10_000, dailyCapPoints: null },
      },
      expected: { kind: 'rejected', code: 'PC_RECEIPT_TOTAL_INVALID' },
    },
    {
      name: 'total that earns zero points -> PC_RECEIPT_TOTAL_INVALID',
      overrides: { totalKopecks: 3_000 },
      expected: { kind: 'rejected', code: 'PC_RECEIPT_TOTAL_INVALID' },
    },
    {
      name: 'manual submission always goes to moderation',
      overrides: { source: 'manual' },
      expected: { kind: 'needs_moderation', reasons: ['manual_submission'], flags: [], score: 0 },
    },
    {
      name: 'unknown fn -> moderation with fn_unknown flag',
      overrides: { fiscalNumber: null, tenant: null },
      expected: {
        kind: 'needs_moderation',
        reasons: ['fn_not_whitelisted'],
        flags: ['fn_unknown'],
        score: 60,
      },
    },
    {
      name: 'pending fn is not whitelisted yet',
      overrides: { fiscalNumber: { status: 'pending', tenantId: null }, tenant: null },
      expected: {
        kind: 'needs_moderation',
        reasons: ['fn_not_whitelisted'],
        flags: ['fn_unknown'],
      },
    },
    {
      name: 'blocked fn -> moderation with a higher score',
      overrides: { fiscalNumber: { status: 'blocked', tenantId: TENANT.id } },
      expected: {
        kind: 'needs_moderation',
        reasons: ['fn_blocked'],
        flags: ['fn_unknown'],
        score: 100,
      },
    },
    {
      name: 'total above the auto-approve threshold -> moderation with high_total',
      overrides: { totalKopecks: 150_000 },
      expected: {
        kind: 'needs_moderation',
        reasons: ['total_above_threshold'],
        flags: ['high_total'],
        score: 40,
      },
    },
    {
      name: 'total exactly at the threshold is auto-approved',
      overrides: { totalKopecks: 100_000 },
      expected: { kind: 'auto_approved', flags: [] },
    },
    {
      name: 'daily receipt limit reached -> moderation',
      overrides: { receiptsToday: 10 },
      expected: { kind: 'needs_moderation', reasons: ['daily_limit_reached'], score: 20 },
    },
    {
      name: 'ninth receipt of the day is still auto-approved',
      overrides: { receiptsToday: 9 },
      expected: { kind: 'auto_approved' },
    },
    {
      name: 'fourth receipt from the same register within 10 minutes -> moderation',
      overrides: { sameFnRecent: 3 },
      expected: { kind: 'needs_moderation', reasons: ['same_fn_burst'], score: 30 },
    },
    {
      name: 'third receipt from the same register is fine',
      overrides: { sameFnRecent: 2 },
      expected: { kind: 'auto_approved' },
    },
    {
      name: 'fast submit is only a flag',
      overrides: { issuedAt: new Date(NOW.getTime() - MINUTE) },
      expected: { kind: 'auto_approved', flags: ['fast_submit'], score: 20 },
    },
    {
      name: 'shared device is only a flag',
      overrides: { deviceShared: true },
      expected: { kind: 'auto_approved', flags: ['device_shared'], score: 30 },
    },
    {
      name: 'manual, unknown fn and high total combine; score is capped at 100',
      overrides: { source: 'manual', fiscalNumber: null, tenant: null, totalKopecks: 1_250_000 },
      expected: {
        kind: 'needs_moderation',
        reasons: ['manual_submission', 'fn_not_whitelisted', 'total_above_threshold'],
        flags: ['fn_unknown', 'high_total'],
        score: 100,
      },
    },
    {
      name: 'seed receipt demo-b: 12 500 UAH from Premier City',
      overrides: {
        totalKopecks: 1_250_000,
        issuedAt: new Date(NOW.getTime() - 45 * MINUTE),
      },
      expected: {
        kind: 'needs_moderation',
        reasons: ['total_above_threshold'],
        flags: ['high_total'],
        score: 40,
      },
    },
  ];

  it.each(cases)('$name', ({ overrides, expected }) => {
    const decision = evaluateReceipt(input(overrides));
    expect(decision.kind).toBe(expected.kind);
    if (expected.code !== undefined) {
      expect(decision.kind === 'rejected' ? decision.code : null).toBe(expected.code);
    }
    if (expected.reasons !== undefined) {
      expect(decision.kind === 'needs_moderation' ? decision.reasons : null).toEqual(
        expected.reasons,
      );
    }
    if (expected.flags !== undefined) {
      expect(decision.risk.flags).toEqual(expected.flags);
    }
    if (expected.score !== undefined) {
      expect(decision.risk.score).toBe(expected.score);
    }
  });

  it('rejections carry a Ukrainian member-facing reason and a technical detail', () => {
    const decision = evaluateReceipt(input({ issuedAt: new Date(NOW.getTime() - 30 * DAY) }));
    expect(decision.kind).toBe('rejected');
    if (decision.kind === 'rejected') {
      expect(decision.reason).toMatch(/вікно/);
      expect(decision.detail).toContain('older than 7 days');
      expect(describeDecision(decision)).toContain('PC_RECEIPT_TOO_OLD');
    }
  });

  it('describes moderation and auto-approval decisions', () => {
    expect(describeDecision(evaluateReceipt(input({ source: 'manual' })))).toBe(
      'moderation: manual_submission',
    );
    expect(describeDecision(evaluateReceipt(input()))).toContain('rules passed');
  });
});

describe('assessRisk', () => {
  it('does not flag fast_submit for receipts dated in the future', () => {
    const risk = assessRisk(input({ issuedAt: new Date(NOW.getTime() + 5 * MINUTE) }));
    expect(risk.flags).toEqual([]);
  });

  it('adds reason weights on top of flag weights', () => {
    const risk = assessRisk(input({ deviceShared: true }), ['same_fn_burst']);
    expect(risk.flags).toEqual(['device_shared']);
    expect(risk.score).toBe(60);
  });
});

describe('points and credit plan', () => {
  const rules: LoyaltyRules = DEFAULT_LOYALTY_RULES;

  it.each([
    ['base rate 3% on 6000.00 UAH', 600_000, null, null, 180],
    ['floor on 123.45 UAH', 12_345, null, null, 3],
    ['tenant override 5%', 600_000, 5, null, 300],
    [
      'tenant rule 10% capped at 500',
      600_000,
      5,
      { ratePercent: 10, minTotalKopecks: 0, dailyCapPoints: null },
      500,
    ],
    [
      'tenant rule rate null falls back to the override',
      600_000,
      5,
      { ratePercent: null, minTotalKopecks: 0, dailyCapPoints: null },
      300,
    ],
    ['zero points below 33.34 UAH', 3_333, null, null, 0],
    ['one point at 33.34 UAH', 3_334, null, null, 1],
  ] as const)('%s', (_name, totalKopecks, override, tenantRule, expected) => {
    const tenant: RuleTenant | null =
      override === null ? TENANT : { ...TENANT, ratePercentOverride: override };
    expect(computePoints({ totalKopecks, rules, tenant, tenantRule })).toBe(expected);
  });

  it('applies the tenant daily cap on top of the receipt cap', () => {
    const tenantRule = { ratePercent: 10, minTotalKopecks: 0, dailyCapPoints: 100 };
    expect(computePoints({ totalKopecks: 600_000, rules, tenant: TENANT, tenantRule })).toBe(100);
    expect(
      computePoints({
        totalKopecks: 600_000,
        rules,
        tenant: TENANT,
        tenantRule,
        tenantPointsToday: 80,
      }),
    ).toBe(20);
    expect(
      computePoints({
        totalKopecks: 600_000,
        rules,
        tenant: TENANT,
        tenantRule,
        tenantPointsToday: 150,
      }),
    ).toBe(0);
  });

  it('returns zero points for invalid totals or rates', () => {
    expect(computePoints({ totalKopecks: 0, rules, tenant: null, tenantRule: null })).toBe(0);
    expect(computePoints({ totalKopecks: -5, rules, tenant: null, tenantRule: null })).toBe(0);
    expect(
      computePoints({
        totalKopecks: 1_000,
        rules: { ...rules, baseRatePercent: 0 },
        tenant: null,
        tenantRule: null,
      }),
    ).toBe(0);
  });

  it('resolves the effective rate in order rule > override > base', () => {
    expect(effectiveRatePercent({ rules, tenant: null, tenantRule: null })).toBe(3);
    expect(
      effectiveRatePercent({
        rules,
        tenant: { ...TENANT, ratePercentOverride: 7 },
        tenantRule: null,
      }),
    ).toBe(7);
    expect(
      effectiveRatePercent({
        rules,
        tenant: { ...TENANT, ratePercentOverride: 7 },
        tenantRule: { ratePercent: 2, minTotalKopecks: 0, dailyCapPoints: null },
      }),
    ).toBe(2);
  });

  it('computes the minimum total from the program and tenant floors', () => {
    expect(minimumTotalKopecks(rules, null)).toBe(1);
    expect(minimumTotalKopecks({ ...rules, minReceiptTotalKopecks: 5_000 }, null)).toBe(5_000);
    expect(
      minimumTotalKopecks(rules, {
        ratePercent: null,
        minTotalKopecks: 7_000,
        dailyCapPoints: null,
      }),
    ).toBe(7_000);
  });

  it('credits immediately below the hold threshold and expires after 12 months', () => {
    const plan = buildCreditPlan({
      totalKopecks: 50_000,
      rules,
      tenant: TENANT,
      tenantRule: null,
      now: NOW,
    });
    expect(plan).toMatchObject({ points: 15, ratePercent: 3, state: 'available' });
    expect(plan.availableAt.toISOString()).toBe(NOW.toISOString());
    expect(plan.expiresAt.toISOString()).toBe('2027-01-15T10:00:00.000Z');
  });

  it('holds points for 7 Kyiv days above the hold threshold', () => {
    const plan = buildCreditPlan({
      totalKopecks: 350_000,
      rules,
      tenant: TENANT,
      tenantRule: null,
      now: NOW,
    });
    expect(plan.state).toBe('pending');
    expect(plan.points).toBe(105);
    expect(plan.availableAt.toISOString()).toBe('2026-01-22T10:00:00.000Z');
    expect(plan.expiresAt.toISOString()).toBe('2027-01-22T10:00:00.000Z');
  });

  it('treats a total exactly at the hold threshold as available', () => {
    const plan = buildCreditPlan({
      totalKopecks: 300_000,
      rules,
      tenant: TENANT,
      tenantRule: null,
      now: NOW,
    });
    expect(plan.state).toBe('available');
  });

  it('keeps the wall-clock time of the hold across the DST switch', () => {
    const beforeDst = new Date('2026-03-25T10:00:00.000Z'); // 12:00 Kyiv, UTC+2
    const plan = buildCreditPlan({
      totalKopecks: 350_000,
      rules,
      tenant: TENANT,
      tenantRule: null,
      now: beforeDst,
    });
    expect(plan.availableAt.toISOString()).toBe('2026-04-01T09:00:00.000Z'); // 12:00 Kyiv, UTC+3
  });

  it('applies the verification hold: pending until verifyUntil, expiry counted from there', () => {
    const verifyUntil = new Date(NOW.getTime() + DAY);
    const plan = buildCreditPlan({
      totalKopecks: 50_000,
      rules,
      tenant: TENANT,
      tenantRule: null,
      now: NOW,
      verificationHoldUntil: verifyUntil,
    });
    expect(plan).toMatchObject({ state: 'pending', verificationHold: true, points: 15 });
    expect(plan.availableAt).toEqual(verifyUntil);
    expect(plan.expiresAt.toISOString()).toBe('2027-01-16T10:00:00.000Z');
  });

  it('keeps the longer high-total hold when both holds apply', () => {
    const plan = buildCreditPlan({
      totalKopecks: 350_000,
      rules,
      tenant: TENANT,
      tenantRule: null,
      now: NOW,
      verificationHoldUntil: new Date(NOW.getTime() + DAY),
    });
    expect(plan).toMatchObject({ state: 'pending', verificationHold: true });
    expect(plan.availableAt.toISOString()).toBe('2026-01-22T10:00:00.000Z');
  });

  it('ignores a verification hold that ends now or earlier', () => {
    const plan = buildCreditPlan({
      totalKopecks: 50_000,
      rules,
      tenant: TENANT,
      tenantRule: null,
      now: NOW,
      verificationHoldUntil: NOW,
    });
    expect(plan).toMatchObject({ state: 'available', verificationHold: false });
  });
});

describe('anti-fraud rules', () => {
  const settings = { verifyHoldHours: 24, newAccountDays: 30, fastTrackMaxKopecks: 50_000 };
  const holdInput = (overrides: Partial<VerificationHoldInput> = {}): VerificationHoldInput => ({
    source: 'qr',
    autoApproved: true,
    totalKopecks: 50_000,
    accountCreatedAt: new Date(NOW.getTime() - 365 * DAY),
    taxCheck: null,
    now: NOW,
    settings,
    ...overrides,
  });

  it.each<[string, Partial<VerificationHoldInput>, string | null]>([
    ['old account, total at the fast-track limit: no hold', {}, null],
    [
      'old account, total above the fast-track limit: 24 h',
      { totalKopecks: 50_001 },
      '2026-01-16T10:00:00.000Z',
    ],
    [
      'account 29 days old: 24 h',
      { accountCreatedAt: new Date(NOW.getTime() - 29 * DAY) },
      '2026-01-16T10:00:00.000Z',
    ],
    [
      'account exactly 30 days old: no hold',
      { accountCreatedAt: new Date(NOW.getTime() - 30 * DAY) },
      null,
    ],
    ['unknown account age: 24 h', { accountCreatedAt: null }, '2026-01-16T10:00:00.000Z'],
    [
      'confirmed by the tax checker: no hold',
      { accountCreatedAt: null, taxCheck: 'confirmed' },
      null,
    ],
    ['manual receipt: no hold', { source: 'manual', accountCreatedAt: null }, null],
    ['moderator approval: no hold', { autoApproved: false, accountCreatedAt: null }, null],
    [
      'hold switched off (0 hours)',
      { accountCreatedAt: null, settings: { ...settings, verifyHoldHours: 0 } },
      null,
    ],
  ])('verificationHoldUntil: %s', (_name, overrides, expected) => {
    const until = verificationHoldUntil(holdInput(overrides));
    expect(until === null ? null : until.toISOString()).toBe(expected);
  });

  it.each([
    [10_000, true],
    [50_000, true],
    [120_000, true],
    [10_050, false],
    [9_900, false],
    [5_000, false],
    [0, false],
  ])('isRoundTotal(%d) = %s', (total, expected) => {
    expect(isRoundTotal(total)).toBe(expected);
  });

  it('round totals repeat only when this one and an earlier one are round', () => {
    expect(isRoundTotalRepeat(20_000, [30_000])).toBe(true);
    expect(isRoundTotalRepeat(20_000, [30_050, 12_345])).toBe(false);
    expect(isRoundTotalRepeat(20_050, [30_000, 40_000])).toBe(false);
    expect(isRoundTotalRepeat(20_000, [])).toBe(false);
  });

  it('flags receipt numbers that go against time on one cash register', () => {
    const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * MINUTE);
    const neighbours = [
      { fiscalId: '1180000100', issuedAt: at(-120) },
      { fiscalId: '1180000300', issuedAt: at(120) },
    ];
    // In order: 100 (-2 h) < 200 (now) < 300 (+2 h).
    expect(isFiscalIdOutOfOrder({ fiscalId: '1180000200', issuedAt: at(0) }, neighbours)).toBe(
      false,
    );
    // A lower number printed later than a higher one.
    expect(isFiscalIdOutOfOrder({ fiscalId: '1180000050', issuedAt: at(0) }, neighbours)).toBe(
      true,
    );
    // A higher number printed earlier than a lower one.
    expect(isFiscalIdOutOfOrder({ fiscalId: '1180000400', issuedAt: at(0) }, neighbours)).toBe(
      true,
    );
    // Within the clock-drift tolerance nothing is compared.
    expect(isFiscalIdOutOfOrder({ fiscalId: '1180000050', issuedAt: at(-119.5) }, neighbours)).toBe(
      false,
    );
    // Alphanumeric ids are never compared.
    expect(isFiscalIdOutOfOrder({ fiscalId: 'AB12', issuedAt: at(0) }, neighbours)).toBe(false);
    expect(
      isFiscalIdOutOfOrder({ fiscalId: '1180000050', issuedAt: at(0) }, [
        { fiscalId: 'XYZ', issuedAt: at(-120) },
      ]),
    ).toBe(false);
  });

  it('caps daily QR points strictly above the cap', () => {
    expect(exceedsDailyQrCap(135, 15, 150)).toBe(false);
    expect(exceedsDailyQrCap(136, 15, 150)).toBe(true);
    expect(exceedsDailyQrCap(0, 151, 150)).toBe(true);
    expect(exceedsDailyQrCap(500, 0, 150)).toBe(false);
    expect(exceedsDailyQrCap(500, 15, null)).toBe(false);
  });

  it.each<[string, Partial<ReceiptRuleInput>, ModerationReason[] | null]>([
    [
      'same total from another member',
      {
        patterns: { sameTotalOtherUser: true, roundTotalRepeat: false, fiscalIdOutOfOrder: false },
      },
      ['same_total_other_user'],
    ],
    [
      'round total repeated',
      {
        patterns: { sameTotalOtherUser: false, roundTotalRepeat: true, fiscalIdOutOfOrder: false },
      },
      ['round_total_repeat'],
    ],
    [
      'receipt number out of order',
      {
        patterns: { sameTotalOtherUser: false, roundTotalRepeat: false, fiscalIdOutOfOrder: true },
      },
      ['fiscal_id_out_of_order'],
    ],
    ['tax checker rejected', { taxCheck: 'rejected' }, ['tax_check_failed']],
    ['tax checker confirmed', { taxCheck: 'confirmed' }, null],
    ['daily QR cap exceeded', { qrPointsToday: 140, dailyQrPointsCap: 150 }, ['daily_points_cap']],
    ['daily QR cap reached exactly', { qrPointsToday: 135, dailyQrPointsCap: 150 }, null],
    [
      'daily QR cap does not apply to manual receipts',
      { source: 'manual', qrPointsToday: 140, dailyQrPointsCap: 150 },
      ['manual_submission'],
    ],
    [
      'daily QR cap is not added when another reason already moderates',
      { totalKopecks: 1_250_000, qrPointsToday: 140, dailyQrPointsCap: 150 },
      ['total_above_threshold'],
    ],
  ])('evaluateReceipt: %s', (_name, overrides, reasons) => {
    const decision = evaluateReceipt(input(overrides));
    if (reasons === null) {
      expect(decision.kind).toBe('auto_approved');
    } else {
      expect(decision.kind).toBe('needs_moderation');
      expect(decision.kind === 'needs_moderation' ? decision.reasons : []).toEqual(reasons);
    }
  });

  it('weights the fraud patterns into the risk score', () => {
    const decision = evaluateReceipt(
      input({
        patterns: { sameTotalOtherUser: true, roundTotalRepeat: true, fiscalIdOutOfOrder: true },
      }),
    );
    expect(decision.risk.score).toBe(100);
  });
});
