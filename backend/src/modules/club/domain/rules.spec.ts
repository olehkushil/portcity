import { DEFAULT_LOYALTY_RULES, type LoyaltyRules } from '../../../common/contracts/club';
import {
  DEFAULT_RULE_SET_ID,
  defaultActiveRuleSet,
  newcomerLockUntil,
  normalizeLoyaltyRules,
  publicRulesView,
  validateLoyaltyRules,
} from './rules';

describe('normalizeLoyaltyRules', () => {
  it('returns the defaults for empty or malformed input', () => {
    expect(normalizeLoyaltyRules({})).toEqual(DEFAULT_LOYALTY_RULES);
    expect(normalizeLoyaltyRules(null)).toEqual(DEFAULT_LOYALTY_RULES);
    expect(normalizeLoyaltyRules('garbage')).toEqual(DEFAULT_LOYALTY_RULES);
    expect(normalizeLoyaltyRules([1, 2])).toEqual(DEFAULT_LOYALTY_RULES);
  });

  it('merges known keys and drops unknown or malformed ones', () => {
    const result = normalizeLoyaltyRules({
      baseRatePercent: 5,
      maxPointsPerReceipt: 'many',
      welcome: { register: 100, profile: null },
      expiryReminderDays: [7, 30, 7, 'x', -2, 1.5],
      unknown: true,
    });
    expect(result).toEqual({
      ...DEFAULT_LOYALTY_RULES,
      baseRatePercent: 5,
      welcome: { register: 100, profile: 30, firstReceipt: 20 },
      expiryReminderDays: [30, 7],
    });
    expect('unknown' in result).toBe(false);
  });

  it('merges a patch over a non-default base', () => {
    const base: LoyaltyRules = {
      ...DEFAULT_LOYALTY_RULES,
      baseRatePercent: 2,
      welcome: { register: 1, profile: 2, firstReceipt: 3 },
    };
    expect(normalizeLoyaltyRules({ holdDays: 3 }, base)).toEqual({ ...base, holdDays: 3 });
  });

  it('never aliases the base object', () => {
    const result = normalizeLoyaltyRules({});
    result.welcome.register = 999;
    result.expiryReminderDays.push(1);
    expect(DEFAULT_LOYALTY_RULES.welcome.register).toBe(50);
    expect(DEFAULT_LOYALTY_RULES.expiryReminderDays).toEqual([30, 7]);
  });
});

describe('validateLoyaltyRules', () => {
  it('accepts the defaults', () => {
    expect(validateLoyaltyRules(DEFAULT_LOYALTY_RULES)).toEqual([]);
  });

  it.each([
    ['baseRatePercent above 100', { baseRatePercent: 101 }, 'baseRatePercent'],
    ['negative rate', { baseRatePercent: -1 }, 'baseRatePercent'],
    ['fractional cap', { maxPointsPerReceipt: 10.5 }, 'maxPointsPerReceipt'],
    ['zero daily limit', { dailyReceiptLimit: 0 }, 'dailyReceiptLimit'],
    ['ttl zero', { pointsTtlMonths: 0 }, 'pointsTtlMonths'],
    ['ttl too long', { pointsTtlMonths: 121 }, 'pointsTtlMonths'],
    [
      'negative welcome',
      { welcome: { register: -5, profile: 0, firstReceipt: 0 } },
      'welcome.register',
    ],
    ['point value zero', { pointValueKopecks: 0 }, 'pointValueKopecks'],
    ['reminder beyond ttl', { expiryReminderDays: [400] }, 'expiryReminderDays'],
    [
      'too many reminders',
      { expiryReminderDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
      'expiryReminderDays',
    ],
  ] as Array<[string, Partial<LoyaltyRules>, string]>)('rejects %s', (_name, patch, field) => {
    const problems = validateLoyaltyRules({ ...DEFAULT_LOYALTY_RULES, ...patch });
    expect(problems.some((problem) => problem.startsWith(field))).toBe(true);
  });

  it('accepts a zero newcomer lock and zero welcome bonuses', () => {
    expect(
      validateLoyaltyRules({
        ...DEFAULT_LOYALTY_RULES,
        newcomerLockHours: 0,
        welcome: { register: 0, profile: 0, firstReceipt: 0 },
        expiryReminderDays: [],
      }),
    ).toEqual([]);
  });
});

describe('publicRulesView', () => {
  it('hides the auto-approve threshold and copies nested values', () => {
    const view = publicRulesView(DEFAULT_LOYALTY_RULES);
    expect('autoApproveThresholdKopecks' in view).toBe(false);
    expect(view.baseRatePercent).toBe(3);
    expect(view.welcome).toEqual({ register: 50, profile: 30, firstReceipt: 20 });
    expect(view.welcome).not.toBe(DEFAULT_LOYALTY_RULES.welcome);
  });
});

describe('defaultActiveRuleSet and newcomerLockUntil', () => {
  it('describes the built-in defaults as version 0', () => {
    const set = defaultActiveRuleSet();
    expect(set.id).toBe(DEFAULT_RULE_SET_ID);
    expect(set.version).toBe(0);
    expect(set.rules).toEqual(DEFAULT_LOYALTY_RULES);
  });

  it.each([
    [72, '2026-01-18T10:00:00.000Z'],
    [1, '2026-01-15T11:00:00.000Z'],
  ])('lock of %d hours ends at %s', (hours, expected) => {
    expect(
      newcomerLockUntil(new Date('2026-01-15T10:00:00.000Z'), {
        newcomerLockHours: hours,
      })?.toISOString(),
    ).toBe(expected);
  });

  it('is disabled for zero or invalid hours', () => {
    expect(newcomerLockUntil(new Date(), { newcomerLockHours: 0 })).toBeNull();
    expect(newcomerLockUntil(new Date(), { newcomerLockHours: Number.NaN })).toBeNull();
  });
});
