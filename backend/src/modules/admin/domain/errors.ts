import type { AdminErrorCode } from '../../../common/contracts/admin';
import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Admin error codes (brief section 3: `PC_<MODULE>_<REASON>`).
 * Names reserved in ADMIN_ERROR_CODES (src/common/contracts/admin.ts) plus the local additions
 * listed in docs/contract-requests/admin.md (amount/account/key/day validation).
 */
export const AdminErrors = defineErrorCodes({
  PC_ADJUSTMENT_NOT_FOUND: { status: 404, title: 'Manual adjustment not found' },
  PC_ADJUSTMENT_INVALID_TRANSITION: {
    status: 409,
    title: 'Manual adjustment state does not allow this action',
  },
  PC_ADJUSTMENT_SELF_APPROVAL: {
    status: 422,
    title: 'A manual adjustment cannot be approved by the admin who requested it',
  },
  PC_ADJUSTMENT_APPROVAL_REQUIRED: {
    status: 422,
    title: 'Manual adjustment needs a second approval before it can be applied',
  },
  PC_ADJUSTMENT_AMOUNT_INVALID: { status: 422, title: 'Manual adjustment amount is invalid' },
  PC_ADJUSTMENT_ACCOUNT_NOT_FOUND: {
    status: 404,
    title: 'The user has no loyalty account to adjust',
  },
  PC_FEATURE_FLAG_NOT_FOUND: { status: 404, title: 'Feature flag not found' },
  PC_FEATURE_FLAG_KEY_INVALID: { status: 400, title: 'Feature flag key is invalid' },
  PC_AUDIT_ACTION_INVALID: { status: 400, title: 'Audit action filter is invalid' },
  PC_REPORT_NOT_READY: { status: 404, title: 'Daily report has not been computed yet' },
  PC_REPORT_DAY_INVALID: { status: 400, title: 'Report day or range is invalid' },
  PC_SUPPORT_REQUEST_NOT_FOUND: { status: 404, title: 'Support request not found' },
  PC_SUPPORT_REQUEST_INVALID_TRANSITION: {
    status: 409,
    title: 'Support request status does not allow this change',
  },
  PC_SUPPORT_REQUEST_DAILY_LIMIT: {
    status: 429,
    title: 'Daily limit of support requests reached',
  },
  PC_SUPPORT_REQUEST_PHOTO_INVALID: { status: 422, title: 'Support request photo is invalid' },
});

export type AdminErrorKey = keyof typeof AdminErrors;

/** Compile-time guard: every code reserved in the contract is registered above. */
type MissingContractCodes = Exclude<AdminErrorCode, AdminErrorKey>;
const _allContractCodesRegistered: MissingContractCodes extends never ? true : never = true;
