import { PUSH_DELIVERY_STATUSES } from '../../../common/contracts/notifications';
import {
  PUSH_DELIVERY_TRANSITIONS,
  assertDeliveryTransition,
  canTransitionDelivery,
  deliveryStatusAfter,
  isFinalDeliveryStatus,
  planDeliveryAttempt,
  shouldRetryDelivery,
} from './push-delivery.machine';

describe('push delivery state machine', () => {
  it('covers every status of the contract', () => {
    expect(Object.keys(PUSH_DELIVERY_TRANSITIONS).sort()).toEqual(
      [...PUSH_DELIVERY_STATUSES].sort(),
    );
  });

  it.each([
    ['queued', 'sent', true],
    ['queued', 'failed', true],
    ['queued', 'skipped', true],
    ['queued', 'queued', false],
    ['failed', 'sent', true],
    ['failed', 'failed', true],
    ['failed', 'skipped', true],
    ['failed', 'queued', false],
    ['sent', 'failed', false],
    ['sent', 'sent', false],
    ['skipped', 'sent', false],
  ] as const)('%s -> %s allowed = %s', (from, to, allowed) => {
    expect(canTransitionDelivery(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertDeliveryTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertDeliveryTransition(from, to)).toThrow(/Invalid push delivery transition/);
    }
  });

  it('sent and skipped are final', () => {
    expect(isFinalDeliveryStatus('sent')).toBe(true);
    expect(isFinalDeliveryStatus('skipped')).toBe(true);
    expect(isFinalDeliveryStatus('queued')).toBe(false);
    expect(isFinalDeliveryStatus('failed')).toBe(false);
  });

  it('maps provider results to statuses', () => {
    expect(deliveryStatusAfter({ ok: true, providerMessageId: 'm-1' })).toBe('sent');
    expect(
      deliveryStatusAfter({ ok: false, code: 'unregistered', retryable: false, message: 'x' }),
    ).toBe('failed');
    expect(
      deliveryStatusAfter({ ok: false, code: 'provider_error', retryable: true, message: 'x' }),
    ).toBe('failed');
    expect(
      deliveryStatusAfter({ ok: false, code: 'not_configured', retryable: false, message: 'x' }),
    ).toBe('skipped');
  });

  it.each([
    ['no row yet', null, 3, 'send'],
    ['queued row', { status: 'queued', attempts: 0 }, 3, 'send'],
    ['failed with attempts left', { status: 'failed', attempts: 1 }, 3, 'send'],
    ['failed and exhausted', { status: 'failed', attempts: 3 }, 3, 'skip_exhausted'],
    ['already sent', { status: 'sent', attempts: 1 }, 3, 'skip_final'],
    ['skipped earlier', { status: 'skipped', attempts: 1 }, 3, 'skip_final'],
  ] as const)('planDeliveryAttempt: %s', (_name, existing, max, expected) => {
    expect(planDeliveryAttempt(existing, max)).toBe(expected);
  });

  it('retries only transient failures while attempts remain', () => {
    const transient = { ok: false, code: 'rate_limited', retryable: true, message: 'x' } as const;
    const permanent = { ok: false, code: 'invalid_token', retryable: false, message: 'x' } as const;
    expect(shouldRetryDelivery(transient, 1, 3)).toBe(true);
    expect(shouldRetryDelivery(transient, 3, 3)).toBe(false);
    expect(shouldRetryDelivery(permanent, 1, 3)).toBe(false);
    expect(shouldRetryDelivery({ ok: true, providerMessageId: null }, 1, 3)).toBe(false);
  });
});
