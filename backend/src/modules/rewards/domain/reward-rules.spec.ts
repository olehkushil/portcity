import { REWARD_KINDS, type RewardKind, type VoucherKind } from '../../../common/contracts/rewards';
import {
  REWARD_UNAVAILABLE_ERRORS,
  REWARD_UNAVAILABLE_REASONS,
  type RewardAvailability,
  type RewardAvailabilitySnapshot,
  checkRewardAvailability,
  computeRewardVoucherExpiry,
  isAffordable,
  isRewardInPeriod,
  isRewardListed,
  remainingForUser,
  voucherKindForReward,
} from './reward-rules';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

const base: RewardAvailabilitySnapshot = {
  active: true,
  validFrom: null,
  validTo: null,
  stock: null,
  perUserLimit: null,
};

describe('isRewardInPeriod / isRewardListed', () => {
  it.each([
    ['open bounds', { validFrom: null, validTo: null }, true],
    ['started yesterday', { validFrom: days(-1), validTo: null }, true],
    ['starts exactly now', { validFrom: NOW, validTo: null }, true],
    ['starts tomorrow', { validFrom: days(1), validTo: null }, false],
    ['ends tomorrow', { validFrom: null, validTo: days(1) }, true],
    ['ends exactly now (exclusive)', { validFrom: null, validTo: NOW }, false],
    ['ended yesterday', { validFrom: null, validTo: days(-1) }, false],
  ])('%s -> %p', (_name, period, expected) => {
    expect(isRewardInPeriod(period, NOW)).toBe(expected);
    expect(isRewardListed({ ...period, active: true }, NOW)).toBe(expected);
    expect(isRewardListed({ ...period, active: false }, NOW)).toBe(false);
  });
});

describe('checkRewardAvailability', () => {
  const cases: Array<[string, Partial<RewardAvailabilitySnapshot>, number, RewardAvailability]> = [
    ['unlimited active reward', {}, 0, { ok: true }],
    ['inactive', { active: false }, 0, { ok: false, reason: 'inactive' }],
    ['inactive wins over stock', { active: false, stock: 0 }, 0, { ok: false, reason: 'inactive' }],
    ['not started', { validFrom: days(1) }, 0, { ok: false, reason: 'not_started' }],
    ['ended', { validTo: days(-1) }, 0, { ok: false, reason: 'ended' }],
    ['ends exactly now', { validTo: NOW }, 0, { ok: false, reason: 'ended' }],
    ['stock left', { stock: 1 }, 0, { ok: true }],
    ['out of stock', { stock: 0 }, 0, { ok: false, reason: 'out_of_stock' }],
    ['negative stock treated as out', { stock: -1 }, 0, { ok: false, reason: 'out_of_stock' }],
    ['below per-user limit', { perUserLimit: 2 }, 1, { ok: true }],
    ['limit reached', { perUserLimit: 2 }, 2, { ok: false, reason: 'limit_reached' }],
    ['limit exceeded', { perUserLimit: 1 }, 3, { ok: false, reason: 'limit_reached' }],
    [
      'out of stock reported before the limit',
      { stock: 0, perUserLimit: 1 },
      1,
      { ok: false, reason: 'out_of_stock' },
    ],
  ];

  it.each(cases)('%s', (_name, overrides, userRedemptions, expected) => {
    expect(checkRewardAvailability({ ...base, ...overrides }, NOW, userRedemptions)).toEqual(
      expected,
    );
  });

  it.each(REWARD_UNAVAILABLE_REASONS)('reason %s maps to a PC_REWARD_* code', (reason) => {
    expect(REWARD_UNAVAILABLE_ERRORS[reason]).toMatch(/^PC_REWARD_/);
  });
});

describe('remainingForUser', () => {
  it.each([
    [null, 5, null],
    [3, 0, 3],
    [3, 2, 1],
    [3, 3, 0],
    [3, 7, 0],
  ])('limit %p with %i redemptions -> %p', (limit, used, expected) => {
    expect(remainingForUser(limit, used)).toBe(expected);
  });
});

describe('isAffordable', () => {
  it.each([
    [60, 320, true],
    [60, 60, true],
    [60, 59, false],
    [60, -10, false],
    [60, null, null],
  ])('cost %i with balance %p -> %p', (cost, balance, expected) => {
    expect(isAffordable(cost, balance)).toBe(expected);
  });
});

describe('computeRewardVoucherExpiry', () => {
  it.each([
    ['ttl only', null, 30, days(30)],
    ['reward ends after the ttl', days(60), 30, days(30)],
    ['reward ends before the ttl', days(10), 30, days(10)],
    ['reward ends exactly at the ttl', days(30), 30, days(30)],
    ['fractional ttl', null, 0.5, new Date(NOW.getTime() + 43_200_000)],
  ])('%s', (_name, validTo, ttlDays, expected) => {
    expect(computeRewardVoucherExpiry({ validTo }, NOW, ttlDays)).toEqual(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects ttl %p', (ttl) => {
    expect(() => computeRewardVoucherExpiry({ validTo: null }, NOW, ttl)).toThrow();
  });
});

describe('voucherKindForReward', () => {
  const expected: Record<RewardKind, VoucherKind> = {
    parking_hour: 'reward',
    partner: 'reward',
    certificate: 'certificate',
    gift: 'reward',
    cinema: 'reward',
  };

  it.each(REWARD_KINDS)('%s', (kind) => {
    expect(voucherKindForReward(kind)).toBe(expected[kind]);
  });
});
