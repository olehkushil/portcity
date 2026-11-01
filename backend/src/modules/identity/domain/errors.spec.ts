import { IDENTITY_ERROR_CODES } from '../../../common/contracts/identity';
import { getErrorCodeDefinition } from '../../../common/errors/error-codes';
import { IdentityErrors } from './errors';

describe('identity error codes', () => {
  it.each(IDENTITY_ERROR_CODES)('registers the reserved code %s', (code) => {
    expect(IdentityErrors[code]).toBe(code);
    expect(getErrorCodeDefinition(code)).toBeDefined();
  });

  it('maps every code to a 4xx/5xx status with a title', () => {
    for (const code of Object.keys(IdentityErrors)) {
      const definition = getErrorCodeDefinition(code);
      expect(definition?.status).toBeGreaterThanOrEqual(400);
      expect(definition?.status).toBeLessThan(600);
      expect(definition?.title.length).toBeGreaterThan(0);
    }
  });
});
