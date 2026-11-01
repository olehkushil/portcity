import type { CreatePaymentInput } from '../../../common/contracts/payments';
import { validateCreatePaymentInput } from './validation';

const base: CreatePaymentInput = {
  userId: 'user-1',
  purpose: 'parking',
  amountKopecks: 6000,
  idempotencyKey: 'parking:session-1:2026-01-15T11:00:00.000Z',
  description: 'Паркінг Порт City до 11:00',
};

describe('validateCreatePaymentInput', () => {
  it('normalises a valid input', () => {
    expect(
      validateCreatePaymentInput({
        ...base,
        idempotencyKey: '  key-1  ',
        description: '  Parking  ',
        meta: { sessionId: 's-1' },
        returnUrl: ' portcity://payments/return ',
      }),
    ).toEqual({
      userId: 'user-1',
      purpose: 'parking',
      amountKopecks: 6000,
      idempotencyKey: 'key-1',
      description: 'Parking',
      meta: { sessionId: 's-1' },
      returnUrl: 'portcity://payments/return',
    });
  });

  it('defaults meta to an empty object and returnUrl to null', () => {
    expect(validateCreatePaymentInput(base)).toMatchObject({ meta: {}, returnUrl: null });
    expect(validateCreatePaymentInput({ ...base, returnUrl: '  ' }).returnUrl).toBeNull();
  });

  it.each([
    [0, 'zero'],
    [-1, 'negative'],
    [10.5, 'fractional'],
    [Number.POSITIVE_INFINITY, 'infinite'],
    ['6000' as unknown as number, 'string'],
  ])('rejects amount %s (%s) with PC_PAYMENT_AMOUNT_INVALID', (amountKopecks) => {
    expect(thrownBy(() => validateCreatePaymentInput({ ...base, amountKopecks }))).toMatchObject({
      code: 'PC_PAYMENT_AMOUNT_INVALID',
      status: 400,
    });
  });

  it.each([
    [{ userId: '' }, 'userId'],
    [{ purpose: 'tickets' as CreatePaymentInput['purpose'] }, 'purpose'],
    [{ idempotencyKey: '' }, 'idempotencyKey'],
    [{ idempotencyKey: 'k'.repeat(256) }, 'idempotencyKey'],
    [{ description: '' }, 'description'],
    [{ description: 'd'.repeat(256) }, 'description'],
    [{ meta: ['x'] as unknown as Record<string, unknown> }, 'meta'],
    [{ returnUrl: 42 as unknown as string }, 'returnUrl'],
  ])('rejects %j as PC_COMMON_VALIDATION on %s', (patch, field) => {
    expect(thrownBy(() => validateCreatePaymentInput({ ...base, ...patch }))).toMatchObject({
      code: 'PC_COMMON_VALIDATION',
      details: [{ path: field }],
    });
  });
});

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
