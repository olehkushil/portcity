import { defineErrorCodes } from '../../../common/errors/error-codes';

/**
 * Error codes of the notifications module (names reserved in
 * src/common/contracts/notifications.ts, NOTIFICATIONS_ERROR_CODES).
 * PC_NOTIFICATION_PREFERENCE_LOCKED is a local addition; its registration in the contract is
 * requested in docs/contract-requests/notifications.md.
 */
export const NotificationErrors = defineErrorCodes({
  PC_NOTIFICATION_NOT_FOUND: { status: 404, title: 'Notification not found' },
  PC_NOTIFICATION_KIND_UNKNOWN: { status: 400, title: 'Unknown notification kind' },
  PC_PUSH_PROVIDER_UNAVAILABLE: { status: 503, title: 'Push provider unavailable' },
  PC_NOTIFICATION_PREFERENCE_LOCKED: {
    status: 422,
    title: 'This notification kind cannot be switched off',
  },
});

export type NotificationErrorCode = keyof typeof NotificationErrors;
