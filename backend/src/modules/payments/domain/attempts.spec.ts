import {
  CHECKOUT_STUCK_AFTER_MS,
  MAX_PAYMENT_ATTEMPTS,
  attemptKey,
  isCheckoutExpired,
  isCheckoutStuck,
  parseAttemptKey,
  tooManyAttempts,
} from './attempts';
import { displayNumberOf, signOperatorQr, verifyOperatorQr } from './receipt';
import { decideAfterCancel } from './reconcile';

const NOW = new Date('2026-11-01T10:00:00.000Z');

describe('payment attempts', () => {
  it('derives and parses attempt keys', () => {
    expect(attemptKey('parking:s:t', 1)).toBe('parking:s:t');
    expect(attemptKey('parking:s:t', 2)).toBe('parking:s:t:a2');
    expect(parseAttemptKey('parking:s:t:a12')).toEqual({ baseKey: 'parking:s:t', attempt: 12 });
    expect(parseAttemptKey('parking:s:t')).toEqual({ baseKey: 'parking:s:t', attempt: 1 });
    expect(() => attemptKey('k', 0)).toThrow();
    expect(tooManyAttempts('k')).toMatchObject({
      code: 'PC_PAYMENT_INVALID_TRANSITION',
      details: { maxAttempts: MAX_PAYMENT_ATTEMPTS },
    });
  });

  it('recognises a checkout that was never opened and one that expired', () => {
    const young = { status: 'created', checkoutUrl: null, createdAt: NOW };
    expect(isCheckoutStuck(young, NOW)).toBe(false);
    const old = { ...young, createdAt: new Date(NOW.getTime() - CHECKOUT_STUCK_AFTER_MS) };
    expect(isCheckoutStuck(old, NOW)).toBe(true);
    expect(isCheckoutStuck({ ...old, checkoutUrl: 'https://x' }, NOW)).toBe(false);
    expect(isCheckoutStuck({ ...old, status: 'failed' }, NOW)).toBe(false);
    expect(isCheckoutExpired('2026-11-01T09:59:59.000Z', NOW)).toBe(true);
    expect(isCheckoutExpired('2026-11-01T10:20:00.000Z', NOW)).toBe(false);
    expect(isCheckoutExpired(null, NOW)).toBe(false);
  });
});

describe('decideAfterCancel', () => {
  const event = (kind: 'succeeded' | 'pending') => ({
    externalId: 'e',
    providerRef: 'r',
    kind,
    raw: {},
  });

  it.each([
    [{ kind: 'cancelled' as const }, { action: 'expire' }],
    [{ kind: 'not_found' as const }, { action: 'expire' }],
    [{ kind: 'final' as const, event: event('succeeded') }, { action: 'apply' }],
    [
      { kind: 'final' as const, event: event('pending') },
      { action: 'skip', reason: 'provider_unavailable' },
    ],
    [
      { kind: 'unavailable' as const, error: 'down' },
      { action: 'skip', reason: 'provider_unavailable' },
    ],
  ])('%j -> %j', (cancel, expected) => {
    expect(decideAfterCancel(cancel)).toMatchObject(expected);
  });
});

describe('receipt helpers', () => {
  it('derives a stable short display number', () => {
    const id = '01900000-0000-7000-8000-000000000001';
    expect(displayNumberOf(id)).toMatch(/^[2-9A-HJ-NP-Z]{4}-\d{4}$/);
    expect(displayNumberOf(id)).toBe(displayNumberOf(id));
    expect(displayNumberOf(id)).not.toBe(displayNumberOf('01900000-0000-7000-8000-000000000002'));
  });

  it('signs and verifies the operator QR, rejecting tampering', () => {
    const facts = {
      paymentId: 'p-1',
      sessionId: 's-1',
      paidUntil: new Date('2026-11-01T14:00:00.000Z'),
      amountKopecks: 6000,
    };
    const payload = signOperatorQr('secret-one-secret', facts);
    expect(payload.startsWith('PCP1.p-1.s-1.')).toBe(true);
    expect(verifyOperatorQr('secret-one-secret', payload)).toEqual(facts);
    expect(verifyOperatorQr('secret-two-secret', payload)).toBeNull();
    expect(verifyOperatorQr('secret-one-secret', payload.replace('.6000.', '.1.'))).toBeNull();
    expect(verifyOperatorQr('secret-one-secret', 'garbage')).toBeNull();
  });
});
