import type { Payment } from '@prisma/client';
import { decodeCursor, encodeCursor } from '../../../common/pagination/cursor';
import {
  INTERNAL_META_KEY,
  buildInitialMeta,
  callerMeta,
  cursorWhere,
  internalMeta,
  isPaymentCursor,
  looksLikeUuid,
  paymentCursorOf,
  toPaymentSummary,
  withInternalMeta,
} from './payment.mapper';

export function paymentRow(overrides: Partial<Payment> = {}): Payment {
  return {
    id: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
    userId: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e00',
    purpose: 'parking',
    amountKopecks: 6000,
    currency: 'UAH',
    provider: 'mock',
    providerRef: 'mock_0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
    status: 'created',
    idempotencyKey: 'parking:s-1:2026-01-15T11:00:00.000Z',
    checkoutUrl: 'http://localhost:3000/mock-checkout/mock_0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
    fiscalReceiptUrl: null,
    failureCode: null,
    refundedKopecks: 0,
    paidAt: null,
    meta: { sessionId: 's-1', [INTERNAL_META_KEY]: { description: 'Parking' } },
    createdAt: new Date('2026-01-15T10:00:00Z'),
    updatedAt: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  };
}

describe('payment mapper', () => {
  it('keeps the reserved meta key the SQL in PaymentsService.findUnfiscalized expects', () => {
    expect(INTERNAL_META_KEY).toBe('_internal');
  });

  it('maps a row to the contract summary without internal meta', () => {
    const summary = toPaymentSummary(paymentRow());
    expect(summary).toMatchObject({
      id: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
      currency: 'UAH',
      status: 'created',
      checkoutUrl: expect.stringContaining('/mock-checkout/'),
      meta: { sessionId: 's-1' },
      refundedKopecks: 0,
    });
    expect(Object.keys(summary.meta)).not.toContain(INTERNAL_META_KEY);
  });

  it('hides the checkout url once the payment is not open', () => {
    expect(toPaymentSummary(paymentRow({ status: 'succeeded' })).checkoutUrl).toBeNull();
    expect(toPaymentSummary(paymentRow({ status: 'pending' })).checkoutUrl).not.toBeNull();
  });

  it('separates caller meta from internal bookkeeping', () => {
    const row = paymentRow();
    expect(callerMeta(row.meta)).toEqual({ sessionId: 's-1' });
    expect(internalMeta(row.meta)).toEqual({ description: 'Parking' });
    expect(callerMeta(null)).toEqual({});
    expect(internalMeta('text')).toEqual({});
    expect(internalMeta({ [INTERNAL_META_KEY]: 'broken' })).toEqual({});
  });

  it('merges internal patches without touching caller fields', () => {
    const row = paymentRow();
    const next = withInternalMeta(row.meta, { returnUrl: 'portcity://x', refunds: [] });
    expect(next).toEqual({
      sessionId: 's-1',
      [INTERNAL_META_KEY]: { description: 'Parking', returnUrl: 'portcity://x', refunds: [] },
    });
    expect(withInternalMeta(null, { description: 'd' })).toEqual({
      [INTERNAL_META_KEY]: { description: 'd' },
    });
    expect(
      buildInitialMeta({ sessionId: 's-2', [INTERNAL_META_KEY]: 'spoof' }, { description: 'x' }),
    ).toEqual({
      sessionId: 's-2',
      [INTERNAL_META_KEY]: { description: 'x' },
    });
  });

  it('drops undefined values when serialising internal meta', () => {
    const next = withInternalMeta({}, { description: 'd', returnUrl: undefined });
    expect(next).toEqual({ [INTERNAL_META_KEY]: { description: 'd' } });
  });

  it('round-trips cursors over (createdAt, id)', () => {
    const row = paymentRow();
    const payload = paymentCursorOf(row);
    expect(payload).toEqual({ createdAt: '2026-01-15T10:00:00.000Z', id: row.id });
    const encoded = encodeCursor(payload);
    expect(decodeCursor(encoded, isPaymentCursor)).toEqual(payload);
    expect(isPaymentCursor({ createdAt: 'nope', id: 'x' })).toBe(false);
    expect(isPaymentCursor({ createdAt: '2026-01-15T10:00:00.000Z' })).toBe(false);
    expect(() => decodeCursor(encodeCursor({ other: 1 }), isPaymentCursor)).toThrow(
      expect.objectContaining({ code: 'PC_COMMON_CURSOR_INVALID' }) as Error,
    );
  });

  it('builds the keyset where clause', () => {
    expect(cursorWhere(undefined)).toEqual([]);
    const where = cursorWhere({ createdAt: '2026-01-15T10:00:00.000Z', id: 'last-id' });
    expect(where).toEqual([
      {
        OR: [
          { createdAt: { lt: new Date('2026-01-15T10:00:00.000Z') } },
          { createdAt: new Date('2026-01-15T10:00:00.000Z'), id: { lt: 'last-id' } },
        ],
      },
    ]);
  });

  it('recognises uuids loosely (any version)', () => {
    expect(looksLikeUuid('0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11')).toBe(true);
    expect(looksLikeUuid('0192F3A0-6C3E-4D2A-9C1B-2F6D2C6A1E11')).toBe(true);
    expect(looksLikeUuid('not-a-uuid')).toBe(false);
    expect(looksLikeUuid(null)).toBe(false);
  });
});
