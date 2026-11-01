import { REWARDS_ERROR_CODES } from '../../../common/contracts/rewards';
import { DomainError } from '../../../common/errors/domain-error';
import { getErrorCodeDefinition } from '../../../common/errors/error-codes';
import { RewardsErrors } from './errors';

describe('RewardsErrors', () => {
  it.each(REWARDS_ERROR_CODES)('registers the reserved contract code %s', (code) => {
    expect(RewardsErrors[code]).toBe(code);
    expect(getErrorCodeDefinition(code)).toBeDefined();
  });

  it.each([
    ['PC_REWARD_NOT_FOUND', 404],
    ['PC_REWARD_INACTIVE', 422],
    ['PC_REWARD_OUT_OF_STOCK', 422],
    ['PC_REWARD_LIMIT_REACHED', 422],
    ['PC_VOUCHER_NOT_FOUND', 404],
    ['PC_VOUCHER_NOT_ACTIVE', 422],
    ['PC_VOUCHER_EXPIRED', 422],
    ['PC_VOUCHER_ALREADY_REDEEMED', 409],
    ['PC_VOUCHER_FINAL', 409],
    ['PC_VOUCHER_WRONG_TENANT', 422],
    ['PC_VOUCHER_CODE_EXHAUSTED', 503],
    ['PC_VALIDATOR_UNAUTHORIZED', 401],
    ['PC_VALIDATOR_PIN_REQUIRED', 401],
    ['PC_VALIDATOR_PIN_INVALID', 401],
    ['PC_VALIDATOR_INACTIVE', 403],
    ['PC_VALIDATOR_NOT_FOUND', 404],
  ])('%s maps to HTTP %i', (code, status) => {
    expect(new DomainError(code).status).toBe(status);
  });
});
