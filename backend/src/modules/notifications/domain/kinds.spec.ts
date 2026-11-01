import {
  MARKETING_NOTIFICATION_KINDS,
  NOTIFICATION_KINDS,
} from '../../../common/contracts/notifications';
import {
  NOTIFICATION_KIND_SPECS,
  RESERVED_DATA_KEYS,
  canOptOut,
  defaultChannelFor,
  getKindSpec,
  isMarketingKind,
  isNotificationKind,
  publicData,
} from './kinds';

describe('notification kind registry', () => {
  it('describes every kind of the contract exactly once, in registry order', () => {
    expect(NOTIFICATION_KIND_SPECS.map((spec) => spec.kind)).toEqual([...NOTIFICATION_KINDS]);
  });

  it.each(NOTIFICATION_KINDS)('%s has a category and a default channel', (kind) => {
    const spec = getKindSpec(kind);
    expect(spec.category.length).toBeGreaterThan(0);
    expect(['inapp', 'push', 'both']).toContain(spec.defaultChannel);
    expect(defaultChannelFor(kind)).toBe(spec.defaultChannel);
  });

  it('marks exactly the contract marketing kinds as marketing', () => {
    const marketing = NOTIFICATION_KINDS.filter((kind) => isMarketingKind(kind));
    expect(marketing).toEqual([...MARKETING_NOTIFICATION_KINDS]);
  });

  it.each([
    ['system', false],
    ['payment_succeeded', false],
    ['payment_failed', false],
    ['payment_refunded', false],
    ['account_deletion_scheduled', false],
    ['account_deletion_cancelled', false],
    ['receipt_credited', true],
    ['promo_published', true],
    ['parking_payable', true],
    ['parking_free_ending', true],
    ['parking_exit_soon', true],
    ['parking_still_inside', true],
    ['parking_opened', true],
    ['event_registered', true],
    ['event_published', true],
    ['support_request_received', false],
  ] as const)('%s opt-out = %s', (kind, expected) => {
    expect(canOptOut(kind)).toBe(expected);
  });

  it('classifies the event and support kinds', () => {
    expect(getKindSpec('event_published')).toMatchObject({
      category: 'marketing',
      marketing: true,
    });
    expect(getKindSpec('event_registered')).toMatchObject({ category: 'events', marketing: false });
    expect(getKindSpec('support_request_received')).toMatchObject({
      category: 'support',
      defaultChannel: 'inapp',
      optOut: false,
    });
  });

  it('recognises kinds and rejects anything else', () => {
    expect(isNotificationKind('receipt_credited')).toBe(true);
    expect(isNotificationKind('RECEIPT_CREDITED')).toBe(false);
    expect(isNotificationKind('')).toBe(false);
    expect(isNotificationKind(42)).toBe(false);
    expect(isNotificationKind(null)).toBe(false);
  });

  it('strips a legacy reserved dedupe key from public data', () => {
    const stored = { receiptId: 'r-1', [RESERVED_DATA_KEYS.dedupeKey]: 'outbox:e-1' };
    expect(publicData(stored)).toEqual({ receiptId: 'r-1' });
    expect(publicData(null)).toEqual({});
    expect(publicData(['x'])).toEqual({});
  });
});
