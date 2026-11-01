import { PROMOS_ERROR_CODES } from '../../../common/contracts/promos';
import { ERROR_CODE_PATTERN, getErrorCodeDefinition } from '../../../common/errors/error-codes';
import { PromosErrors } from './errors';

describe('promos error codes', () => {
  it.each(PROMOS_ERROR_CODES)('registers the reserved contract code %s', (code) => {
    expect(PromosErrors[code]).toBe(code);
    expect(getErrorCodeDefinition(code)).toBeDefined();
  });

  it('uses only PC_<MODULE>_<REASON> names with 4xx statuses', () => {
    for (const code of Object.keys(PromosErrors)) {
      expect(code).toMatch(ERROR_CODE_PATTERN);
      const definition = getErrorCodeDefinition(code);
      expect(definition?.status).toBeGreaterThanOrEqual(400);
      expect(definition?.status).toBeLessThan(500);
    }
  });

  it('maps not-found codes to 404 and state conflicts to 409', () => {
    expect(getErrorCodeDefinition(PromosErrors.PC_PROMO_NOT_FOUND)?.status).toBe(404);
    expect(getErrorCodeDefinition(PromosErrors.PC_EVENT_NOT_FOUND)?.status).toBe(404);
    expect(getErrorCodeDefinition(PromosErrors.PC_EVENT_NOT_REGISTERED)?.status).toBe(404);
    expect(getErrorCodeDefinition(PromosErrors.PC_EVENT_ALREADY_REGISTERED)?.status).toBe(409);
    expect(getErrorCodeDefinition(PromosErrors.PC_PROMO_INVALID_TRANSITION)?.status).toBe(409);
  });
});
