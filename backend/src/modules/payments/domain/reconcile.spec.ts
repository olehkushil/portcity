import type { PaymentStatus } from '../../../common/contracts/payments';
import type { ProviderPaymentEvent } from './provider-events';
import {
  type ProviderLookup,
  type ReconcilablePayment,
  decideReconciliation,
  expirationEvent,
  paymentAgeMinutes,
} from './reconcile';

const NOW = new Date('2026-01-15T10:00:00.000Z');
const TIMEOUT = 20;

function payment(
  status: PaymentStatus,
  ageMinutes: number,
  providerRef: string | null = 'ref-1',
): ReconcilablePayment {
  return {
    id: 'pay-1',
    status,
    providerRef,
    createdAt: new Date(NOW.getTime() - ageMinutes * 60_000),
  };
}

function lookup(kind: ProviderPaymentEvent['kind']): ProviderLookup {
  return { kind: 'event', event: { externalId: `e-${kind}`, providerRef: 'ref-1', kind, raw: {} } };
}

describe('decideReconciliation', () => {
  const table: ReadonlyArray<[string, ReconcilablePayment, ProviderLookup | null, unknown]> = [
    [
      'settled payments are skipped',
      payment('succeeded', 90),
      lookup('succeeded'),
      { action: 'skip', reason: 'not_open' },
    ],
    [
      'final payments are skipped',
      payment('failed', 90),
      null,
      { action: 'skip', reason: 'not_open' },
    ],
    [
      'young created payment waits',
      payment('created', 5),
      null,
      { action: 'skip', reason: 'too_young' },
    ],
    [
      'young pending payment waits',
      payment('pending', 19.9),
      lookup('succeeded'),
      { action: 'skip', reason: 'too_young' },
    ],
    [
      'exactly at the timeout is old enough',
      payment('pending', 20),
      lookup('failed'),
      { action: 'apply' },
    ],
    [
      'no provider reference (checkout never opened) expires',
      payment('created', 60, null),
      null,
      { action: 'expire', reason: 'checkout_not_created' },
    ],
    [
      'provider outage waits for the next run',
      payment('pending', 60),
      { kind: 'unavailable', error: 'timeout' },
      { action: 'skip', reason: 'provider_unavailable' },
    ],
    [
      'unknown at provider expires',
      payment('pending', 60),
      { kind: 'not_found' },
      { action: 'expire', reason: 'unknown_at_provider' },
    ],
    [
      'no answer expires',
      payment('created', 60),
      null,
      { action: 'expire', reason: 'unknown_at_provider' },
    ],
    [
      'still pending at provider expires',
      payment('pending', 60),
      lookup('pending'),
      { action: 'expire', reason: 'still_open_at_provider' },
    ],
    [
      'succeeded at provider is applied',
      payment('pending', 60),
      lookup('succeeded'),
      { action: 'apply', event: expect.objectContaining({ kind: 'succeeded' }) },
    ],
    [
      'failed at provider is applied',
      payment('created', 25),
      lookup('failed'),
      { action: 'apply', event: expect.objectContaining({ kind: 'failed' }) },
    ],
    [
      'cancelled at provider is applied',
      payment('pending', 25),
      lookup('cancelled'),
      { action: 'apply' },
    ],
    [
      'expired at provider is applied',
      payment('pending', 25),
      lookup('expired'),
      { action: 'apply' },
    ],
  ];

  it.each(table)('%s', (_name, subject, answer, expected) => {
    expect(decideReconciliation(subject, answer, NOW, TIMEOUT)).toMatchObject(expected as object);
  });

  it('computes the age in minutes', () => {
    expect(paymentAgeMinutes(payment('created', 45), NOW)).toBe(45);
  });

  it('builds a synthetic expiration event traceable to the job', () => {
    const subject = payment('pending', 60);
    expect(expirationEvent(subject, NOW, 'unknown_at_provider')).toEqual({
      externalId: 'reconcile:pay-1:2026-01-15T10:00:00.000Z',
      providerRef: 'ref-1',
      paymentId: 'pay-1',
      kind: 'expired',
      failureCode: 'unknown_at_provider',
      raw: { source: 'payments-reconcile', reason: 'unknown_at_provider' },
    });
    expect(expirationEvent(payment('created', 60, null), NOW, 'x').providerRef).toBe('pay-1');
  });
});
