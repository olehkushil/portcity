import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Error codes of the promos module. The first block is reserved in
 * `src/common/contracts/promos.ts` (PROMOS_ERROR_CODES); the second block is module-local and
 * requested for the contract in `docs/contract-requests/promos.md`.
 */
export const PromosErrors = defineErrorCodes({
  // Reserved in the contract.
  PC_PROMO_NOT_FOUND: { status: 404, title: 'Promo not found' },
  PC_PROMO_NOT_PUBLISHED: { status: 422, title: 'Promo is not published' },
  PC_PROMO_NOT_COUPON: { status: 422, title: 'Promo does not issue coupons' },
  PC_PROMO_EXPIRED: { status: 422, title: 'Promo is outside its validity window' },
  PC_COUPON_LIMIT_REACHED: { status: 422, title: 'Coupon limit per member reached' },
  PC_COUPON_SOLD_OUT: { status: 422, title: 'All coupons of this promo have been claimed' },
  PC_EVENT_NOT_FOUND: { status: 404, title: 'Event not found' },
  PC_EVENT_REGISTRATION_CLOSED: { status: 422, title: 'Registration for this event is closed' },
  PC_EVENT_FULL: { status: 422, title: 'No seats left for this event' },
  PC_EVENT_ALREADY_REGISTERED: { status: 409, title: 'Already registered for this event' },
  PC_EVENT_NOT_REGISTERED: { status: 404, title: 'No active registration for this event' },
  PC_EVENT_PERSONS_INVALID: { status: 422, title: 'Invalid number of persons' },
  // Module-local additions (back-office flows).
  PC_PROMO_INVALID_TRANSITION: { status: 409, title: 'Promo status transition is not allowed' },
  PC_PROMO_DATES_INVALID: { status: 422, title: 'Promo validity window is invalid' },
  PC_PROMO_TENANT_NOT_FOUND: { status: 422, title: 'Promo tenant not found' },
  PC_PROMO_TEMPLATE_REQUIRED: { status: 422, title: 'A coupon promo needs a coupon template' },
  PC_PROMO_NOT_DRAFT: { status: 409, title: 'Only draft promos can be deleted' },
  PC_COUPON_TEMPLATE_NOT_FOUND: { status: 404, title: 'Coupon template not found' },
  PC_COUPON_TEMPLATE_IN_USE: { status: 409, title: 'Coupon template is linked to a promo' },
  PC_COUPON_TEMPLATE_LIMITS_INVALID: { status: 422, title: 'Coupon template limits are invalid' },
  PC_EVENT_INVALID_TRANSITION: { status: 409, title: 'Event status transition is not allowed' },
  PC_EVENT_DATES_INVALID: { status: 422, title: 'Event time window is invalid' },
  PC_EVENT_CAPACITY_INVALID: {
    status: 422,
    title: 'Event capacity is below the number of registered persons',
  },
  PC_EVENT_NOT_DRAFT: { status: 409, title: 'Only draft events can be deleted' },
  PC_EVENT_CANCEL_DEADLINE_PASSED: {
    status: 422,
    title: 'The registration can no longer be cancelled',
  },
  PC_EVENT_REGISTRATION_NOT_FOUND: { status: 404, title: 'Registration not found' },
  PC_EVENT_REGISTRATION_FINAL: { status: 409, title: 'Registration is already used or cancelled' },
  PC_EVENT_TENANT_NOT_FOUND: { status: 404, title: 'Event tenant not found' },
  PC_EVENT_AGE_RANGE_INVALID: { status: 422, title: 'Event age range is invalid' },
  PC_EVENT_ADMISSION_INVALID: { status: 422, title: 'Event admission settings are invalid' },
});

export type PromosModuleErrorCode = keyof typeof PromosErrors;
