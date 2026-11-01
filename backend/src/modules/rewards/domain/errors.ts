import type { RewardsErrorCode } from '../../../common/contracts/rewards';
import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Error codes of the rewards module (names reserved in src/common/contracts/rewards.ts).
 * PC_VALIDATOR_NOT_FOUND is an addition for the back-office CRUD of validator devices;
 * it is requested for the contract in docs/contract-requests/rewards.md.
 */
export const RewardsErrors = defineErrorCodes({
  PC_REWARD_NOT_FOUND: { status: 404, title: 'Reward not found' },
  PC_REWARD_INACTIVE: { status: 422, title: 'Reward is not available' },
  PC_REWARD_OUT_OF_STOCK: { status: 422, title: 'Reward is out of stock' },
  PC_REWARD_LIMIT_REACHED: { status: 422, title: 'Per-user limit for this reward reached' },
  PC_VOUCHER_NOT_FOUND: { status: 404, title: 'Voucher not found' },
  PC_VOUCHER_NOT_ACTIVE: { status: 422, title: 'Voucher is not active' },
  PC_VOUCHER_EXPIRED: { status: 422, title: 'Voucher has expired' },
  PC_VOUCHER_ALREADY_REDEEMED: { status: 409, title: 'Voucher was already redeemed' },
  PC_VOUCHER_FINAL: { status: 409, title: 'Voucher is in a final state' },
  PC_VOUCHER_WRONG_TENANT: { status: 422, title: 'Voucher cannot be redeemed at this point' },
  PC_VOUCHER_CODE_EXHAUSTED: { status: 503, title: 'Could not allocate an activation code' },
  PC_VALIDATOR_UNAUTHORIZED: { status: 401, title: 'Validator device key is missing or unknown' },
  PC_VALIDATOR_PIN_REQUIRED: { status: 401, title: 'Validator shift PIN is required' },
  PC_VALIDATOR_PIN_INVALID: { status: 401, title: 'Validator PIN is invalid' },
  PC_VALIDATOR_INACTIVE: { status: 403, title: 'Validator device is inactive or revoked' },
  PC_VALIDATOR_NOT_FOUND: { status: 404, title: 'Validator device not found' },
  PC_VALIDATOR_PIN_LOCKED: {
    status: 429,
    title: 'Too many wrong PINs; the device is locked for a while',
  },
});

/** Compile-time guard: every reserved contract code is registered above. */
type ReservedCodes = { readonly [K in RewardsErrorCode]: K };
export const reservedRewardsErrorCodes: ReservedCodes = RewardsErrors;
