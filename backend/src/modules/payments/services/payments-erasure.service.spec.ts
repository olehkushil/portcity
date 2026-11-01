import {
  MEMBER_ID,
  createPaymentsHarness,
} from '../../../../test/payments/support/payments-harness';

describe('PaymentsErasureService (user.deleted)', () => {
  it('removes personal data from the meta of the member payments and keeps the money facts', async () => {
    const h = createPaymentsHarness();
    const parking = await h.payments.createPayment({
      userId: MEMBER_ID,
      purpose: 'parking',
      amountKopecks: 6000,
      idempotencyKey: 'parking:s-1:16:00',
      description: 'Паркінг Порт City, AC 1234 BC, виїзд до 16:00, 60 ₴',
      meta: { sessionId: 's-1', plate: 'AC1234BC', providerRef: 'op-1' },
    });
    const other = await h.payments.createPayment({
      userId: '01900000-0000-7000-8000-000000000099',
      purpose: 'parking',
      amountKopecks: 4000,
      idempotencyKey: 'parking:s-2:17:00',
      description: 'Паркінг Порт City, BC 0001 AA',
      meta: { sessionId: 's-2', plate: 'BC0001AA' },
    });

    expect(await h.erasure.eraseUser(MEMBER_ID)).toEqual({
      userId: MEMBER_ID,
      checked: 1,
      scrubbed: 1,
    });

    const row = h.prisma.payments.find((entry) => entry.id === parking.id);
    const meta = row?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({ sessionId: 's-1', providerRef: 'op-1' });
    expect(meta).not.toHaveProperty('plate');
    expect(meta['_internal']).toMatchObject({ description: 'Паркінг Порт City' });
    expect(row).toMatchObject({ amountKopecks: 6000, status: parking.status, userId: MEMBER_ID });

    const untouched = h.prisma.payments.find((entry) => entry.id === other.id);
    expect(untouched?.meta).toMatchObject({ plate: 'BC0001AA' });

    // A repeated delivery changes nothing.
    expect(await h.erasure.eraseUser(MEMBER_ID)).toEqual({
      userId: MEMBER_ID,
      checked: 1,
      scrubbed: 0,
    });
  });
});
