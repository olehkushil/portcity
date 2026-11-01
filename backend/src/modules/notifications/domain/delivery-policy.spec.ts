import type { DeviceSummary } from '../../../common/contracts/identity';
import {
  type DeliveryDecision,
  type DeliveryDecisionInput,
  decideDelivery,
  initialSentAt,
  needsPush,
  selectPushTargets,
} from './delivery-policy';

const base: DeliveryDecisionInput = {
  kind: 'receipt_credited',
  userStatus: 'active',
  preferenceEnabled: null,
  hasMarketingConsent: null,
};

describe('decideDelivery', () => {
  const cases: Array<[string, Partial<DeliveryDecisionInput>, DeliveryDecision]> = [
    ['active user, no preference row', {}, { deliver: true, channel: 'both' }],
    [
      'requested channel wins over the kind default',
      { requestedChannel: 'inapp' },
      { deliver: true, channel: 'inapp' },
    ],
    [
      'kind default channel is used when none requested',
      { kind: 'voucher_redeemed' },
      { deliver: true, channel: 'inapp' },
    ],
    ['unknown user', { userStatus: null }, { deliver: false, reason: 'user_missing' }],
    ['blocked user', { userStatus: 'blocked' }, { deliver: false, reason: 'user_inactive' }],
    ['deleted user', { userStatus: 'deleted' }, { deliver: false, reason: 'user_inactive' }],
    [
      'preference switched off',
      { preferenceEnabled: false },
      { deliver: false, reason: 'preference_disabled' },
    ],
    ['preference explicitly on', { preferenceEnabled: true }, { deliver: true, channel: 'both' }],
    [
      'marketing kind without consent',
      { kind: 'promo_published', hasMarketingConsent: false },
      { deliver: false, reason: 'consent_missing' },
    ],
    [
      'marketing kind with unknown consent',
      { kind: 'promo_published', hasMarketingConsent: null },
      { deliver: false, reason: 'consent_missing' },
    ],
    [
      'marketing kind with consent',
      { kind: 'promo_published', hasMarketingConsent: true },
      { deliver: true, channel: 'both' },
    ],
    [
      'marketing consent is checked before the preference',
      { kind: 'promo_published', hasMarketingConsent: false, preferenceEnabled: false },
      { deliver: false, reason: 'consent_missing' },
    ],
    [
      'inactive user wins over everything',
      { userStatus: 'blocked', preferenceEnabled: false },
      { deliver: false, reason: 'user_inactive' },
    ],
  ];

  it.each(cases)('%s', (_name, overrides, expected) => {
    expect(decideDelivery({ ...base, ...overrides })).toEqual(expected);
  });
});

describe('channel helpers', () => {
  const now = new Date('2026-03-01T10:00:00Z');

  it('in-app notifications are sent at creation, push ones later', () => {
    expect(initialSentAt('inapp', now)).toEqual(now);
    expect(initialSentAt('push', now)).toBeNull();
    expect(initialSentAt('both', now)).toBeNull();
  });

  it('needsPush', () => {
    expect(needsPush('inapp')).toBe(false);
    expect(needsPush('push')).toBe(true);
    expect(needsPush('both')).toBe(true);
  });
});

describe('selectPushTargets', () => {
  const device = (overrides: Partial<DeviceSummary>): DeviceSummary => ({
    id: 'd-1',
    userId: 'u-1',
    platform: 'android',
    model: null,
    appVersion: null,
    fingerprint: null,
    pushToken: 'token-1',
    pushEnabled: true,
    lastSeenAt: null,
    ...overrides,
  });

  it('keeps enabled devices with a token and drops duplicate tokens', () => {
    const targets = selectPushTargets([
      device({ id: 'd-1', pushToken: 'tok-a' }),
      device({ id: 'd-2', pushToken: 'tok-a' }),
      device({ id: 'd-3', pushToken: 'tok-b', pushEnabled: false }),
      device({ id: 'd-4', pushToken: null }),
      device({ id: 'd-5', pushToken: '   ' }),
      device({ id: 'd-6', pushToken: 'tok-c' }),
    ]);
    expect(targets.map((target) => target.id)).toEqual(['d-1', 'd-6']);
  });

  it('returns an empty list for no devices', () => {
    expect(selectPushTargets([])).toEqual([]);
  });
});
