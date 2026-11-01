import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Identity error codes. The names listed in IDENTITY_ERROR_CODES (src/common/contracts/identity.ts)
 * are reserved there; the remaining codes are module-local. HTTP statuses:
 * 401 for failed authentication steps, 403 for blocked principals, 409 for conflicts,
 * 410 for deleted accounts, 422 for business rules, 429 for rate limits.
 */
export const IdentityErrors = defineErrorCodes({
  PC_OTP_INVALID: { status: 401, title: 'OTP code is invalid' },
  PC_OTP_EXPIRED: { status: 401, title: 'OTP code has expired' },
  PC_OTP_TOO_MANY_ATTEMPTS: { status: 429, title: 'Too many OTP attempts' },
  PC_OTP_RATE_LIMITED: { status: 429, title: 'Too many OTP requests' },
  PC_OTP_DELIVERY_FAILED: { status: 503, title: 'OTP could not be delivered' },
  PC_OTP_LOCKED: { status: 429, title: 'Too many wrong codes for this phone' },
  PC_OTP_CAPTCHA_REQUIRED: { status: 403, title: 'Captcha verification required' },
  PC_OTP_SMS_BUDGET_EXHAUSTED: { status: 503, title: 'SMS sending is paused for today' },
  PC_REFRESH_INVALID: { status: 401, title: 'Refresh token is invalid' },
  PC_REFRESH_REUSED: { status: 401, title: 'Refresh token reuse detected' },
  PC_USER_NOT_FOUND: { status: 404, title: 'User not found' },
  PC_USER_BLOCKED: { status: 403, title: 'User is blocked' },
  PC_USER_DELETED: { status: 410, title: 'User account is deleted' },
  PC_USER_EMAIL_TAKEN: { status: 409, title: 'Email is already used by another account' },
  PC_USER_BIRTHDATE_INVALID: { status: 422, title: 'Birth date is not acceptable' },
  PC_USER_INVALID_TRANSITION: { status: 409, title: 'User status transition is not allowed' },
  PC_USER_CHILD_NOT_FOUND: { status: 404, title: 'Child not found' },
  PC_USER_CHILD_LIMIT: { status: 422, title: 'Too many children in the profile' },
  PC_USER_CHILD_BIRTH_INVALID: { status: 422, title: 'Child birth month is not acceptable' },
  PC_DEVICE_NOT_FOUND: { status: 404, title: 'Device not found' },
  PC_CONSENT_PROGRAM_REQUIRED: {
    status: 422,
    title: 'Program consent cannot be revoked while the account exists',
  },
  PC_DELETION_NOT_PENDING: { status: 404, title: 'No pending deletion request' },
  PC_ADMIN_CREDENTIALS_INVALID: { status: 401, title: 'Invalid email or password' },
  PC_ADMIN_TOTP_REQUIRED: { status: 401, title: 'Second factor required' },
  PC_ADMIN_TOTP_INVALID: { status: 401, title: 'Second factor code is invalid' },
  PC_ADMIN_INACTIVE: { status: 403, title: 'Admin account is deactivated' },
  PC_ADMIN_CHALLENGE_INVALID: { status: 401, title: 'Login challenge is invalid or expired' },
  PC_ADMIN_NOT_FOUND: { status: 404, title: 'Admin user not found' },
  PC_ADMIN_EMAIL_TAKEN: { status: 409, title: 'Admin email is already registered' },
  PC_ADMIN_LAST_OWNER: {
    status: 422,
    title: 'The last active owner cannot be demoted or deactivated',
  },
  PC_ADMIN_SELF_ACTION: { status: 422, title: 'This action cannot be applied to your own account' },
  PC_ADMIN_TOTP_NOT_ENABLED: { status: 409, title: 'TOTP is not enabled for this admin' },
  PC_ADMIN_TOTP_ALREADY_ENABLED: { status: 409, title: 'TOTP is already enabled for this admin' },
  PC_ADMIN_TOTP_SETUP_REQUIRED: {
    status: 403,
    title: 'This role requires a second factor; set up TOTP to sign in',
  },
  PC_ADMIN_TOTP_REQUIRED_FOR_ROLE: {
    status: 409,
    title: 'TOTP cannot be disabled for this role',
  },
  PC_ADMIN_LOGIN_LOCKED: { status: 429, title: 'Admin login temporarily locked' },
  PC_ADMIN_LOGIN_BUSY: { status: 429, title: 'Too many logins in progress; retry shortly' },
});

export type IdentityErrorKey = keyof typeof IdentityErrors;
