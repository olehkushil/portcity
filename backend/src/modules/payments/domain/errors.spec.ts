import { PAYMENTS_ERROR_CODES } from '../../../common/contracts/payments';
import { getErrorCodeDefinition } from '../../../common/errors/error-codes';
import { PaymentErrors } from './errors';

describe('payment error codes', () => {
  it('registers every code reserved in the payments contract', () => {
    expect(Object.keys(PaymentErrors).sort()).toEqual([...PAYMENTS_ERROR_CODES].sort());
    for (const code of PAYMENTS_ERROR_CODES) {
      const definition = getErrorCodeDefinition(code);
      expect(definition).toBeDefined();
      expect(definition?.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('uses the statuses the API documents', () => {
    expect(getErrorCodeDefinition('PC_PAYMENT_NOT_FOUND')?.status).toBe(404);
    expect(getErrorCodeDefinition('PC_PAYMENT_WEBHOOK_SIGNATURE')?.status).toBe(401);
    expect(getErrorCodeDefinition('PC_PAYMENT_WEBHOOK_MALFORMED')?.status).toBe(400);
    expect(getErrorCodeDefinition('PC_PAYMENT_PROVIDER_ERROR')?.status).toBe(502);
    expect(getErrorCodeDefinition('PC_PAYMENT_INVALID_TRANSITION')?.status).toBe(409);
    expect(getErrorCodeDefinition('PC_PAYMENT_REFUND_NOT_ALLOWED')?.status).toBe(422);
  });
});
