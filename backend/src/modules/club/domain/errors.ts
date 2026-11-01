import type { ClubErrorCode } from '../../../common/contracts/club';
import { defineErrorCodes } from '../../../common/errors/error-codes';

/** Club error codes (names reserved in src/common/contracts/club.ts, CLUB_ERROR_CODES). */
export const ClubErrors = defineErrorCodes({
  PC_POINTS_INSUFFICIENT: { status: 422, title: 'Not enough points' },
  PC_POINTS_ACCOUNT_NEGATIVE: {
    status: 422,
    title: 'Spending is blocked while the balance is negative',
  },
  PC_POINTS_NEWCOMER_LOCK: { status: 422, title: 'Spending is locked for new members' },
  PC_POINTS_ACCOUNT_NOT_FOUND: { status: 404, title: 'Loyalty account not found' },
  PC_POINTS_TX_NOT_FOUND: { status: 404, title: 'Points transaction not found' },
  PC_POINTS_INVALID_TRANSITION: {
    status: 409,
    title: 'Points transaction cannot move to that state',
  },
  PC_POINTS_INVALID_AMOUNT: { status: 400, title: 'Points amount is invalid' },
  PC_RULESET_NOT_FOUND: { status: 404, title: 'Loyalty rule set not found' },
  PC_RULESET_VERSION_TAKEN: { status: 409, title: 'Loyalty rule set version already exists' },
});

/** Compile-time check: every reserved contract code is registered above (and nothing else). */
const _reservedCodes: Record<ClubErrorCode, ClubErrorCode> = ClubErrors;
const _registeredCodes: Record<keyof typeof ClubErrors, ClubErrorCode> = ClubErrors;
void _reservedCodes;
void _registeredCodes;
