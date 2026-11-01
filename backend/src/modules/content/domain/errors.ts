import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Error codes of the content module (brief section 3: PC_<MODULE>_<REASON>).
 * The first seven are reserved in `src/common/contracts/content.ts` (CONTENT_ERROR_CODES);
 * the remaining ones are local additions requested in docs/contract-requests/content.md.
 */
export const ContentErrors = defineErrorCodes({
  PC_TENANT_NOT_FOUND: { status: 404, title: 'Tenant not found' },
  PC_TENANT_SLUG_TAKEN: { status: 409, title: 'Tenant slug is already used' },
  PC_FISCAL_NUMBER_INVALID: { status: 400, title: 'Fiscal number is invalid' },
  PC_FISCAL_NUMBER_TAKEN: { status: 409, title: 'Fiscal number is already registered' },
  PC_FISCAL_NUMBER_NOT_FOUND: { status: 404, title: 'Fiscal number not found' },
  PC_TENANT_RULE_NOT_FOUND: { status: 404, title: 'Tenant loyalty rule not found' },
  PC_TENANT_RULE_OVERLAP: { status: 409, title: 'Tenant loyalty rule overlaps an existing rule' },
  // local additions (see docs/contract-requests/content.md)
  PC_TENANT_INVALID_TRANSITION: {
    status: 409,
    title: 'Tenant status transition is not allowed',
  },
  PC_FISCAL_NUMBER_INVALID_TRANSITION: {
    status: 409,
    title: 'Fiscal number status transition is not allowed',
  },
  PC_FISCAL_NUMBER_TENANT_REQUIRED: {
    status: 422,
    title: 'An active fiscal number must be mapped to a tenant',
  },
  PC_TENANT_RULE_INVALID_PERIOD: {
    status: 422,
    title: 'Tenant loyalty rule period is invalid',
  },
  PC_CONTENT_IMPORT_NOT_FOUND: { status: 404, title: 'Content import run not found' },
  PC_CONTENT_IMPORT_EMPTY: { status: 422, title: 'Content import has nothing to import' },
});

export type ContentErrorCodeName = keyof typeof ContentErrors;
