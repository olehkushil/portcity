import {
  MARKETING_NOTIFICATION_KINDS,
  NOTIFICATION_KINDS,
  type NotificationChannel,
  type NotificationKind,
} from '../../../common/contracts/notifications';

/** Grouping used by the preferences screen of the app. */
export const NOTIFICATION_CATEGORIES = [
  'receipts',
  'points',
  'vouchers',
  'events',
  'parking',
  'payments',
  'account',
  'support',
  'marketing',
  'system',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface NotificationKindSpec {
  kind: NotificationKind;
  category: NotificationCategory;
  /** Channel used when the caller does not name one. */
  defaultChannel: NotificationChannel;
  /** False for service notifications a member cannot switch off (payments, account, system). */
  optOut: boolean;
  /** True when the kind needs the `marketing` consent. */
  marketing: boolean;
}

type SpecWithoutKind = Omit<NotificationKindSpec, 'kind'>;

const service = (
  category: NotificationCategory,
  defaultChannel: NotificationChannel = 'both',
  optOut = true,
): SpecWithoutKind => ({ category, defaultChannel, optOut, marketing: false });

const SPECS: Readonly<Record<NotificationKind, SpecWithoutKind>> = Object.freeze({
  receipt_credited: service('receipts'),
  receipt_held: service('receipts'),
  receipt_needs_moderation: service('receipts'),
  receipt_approved: service('receipts'),
  receipt_rejected: service('receipts'),
  points_released: service('points'),
  points_expiring: service('points'),
  points_expired: service('points', 'inapp'),
  points_adjusted: service('points'),
  voucher_issued: service('vouchers'),
  voucher_redeemed: service('vouchers', 'inapp'),
  voucher_expiring: service('vouchers'),
  voucher_cancelled: service('vouchers'),
  ticket_reminder: service('events'),
  event_registered: service('events'),
  event_published: { category: 'marketing', defaultChannel: 'both', optOut: true, marketing: true },
  parking_opened: service('parking'),
  parking_free_ending: service('parking'),
  parking_payable: service('parking'),
  parking_paid: service('parking'),
  parking_exit_soon: service('parking'),
  parking_overstay: service('parking'),
  parking_still_inside: service('parking'),
  parking_closed: service('parking', 'inapp'),
  /** Confirmation of POST /parking/session/:id/dispute (the session leaves the hero). */
  parking_disputed: service('parking', 'inapp'),
  payment_succeeded: service('payments', 'both', false),
  payment_failed: service('payments', 'both', false),
  /** Money back on the card (parking payment the session could not use, or a back-office refund). */
  payment_refunded: service('payments', 'both', false),
  account_deletion_scheduled: service('account', 'both', false),
  account_deletion_cancelled: service('account', 'both', false),
  promo_published: { category: 'marketing', defaultChannel: 'both', optOut: true, marketing: true },
  /** "Звернення № 1042 прийнято": in-app confirmation, cannot be switched off. */
  support_request_received: service('support', 'inapp', false),
  system: service('system', 'both', false),
});

/** Every kind with its delivery rules, in registry order. */
export const NOTIFICATION_KIND_SPECS: readonly NotificationKindSpec[] = Object.freeze(
  NOTIFICATION_KINDS.map((kind) => Object.freeze({ kind, ...SPECS[kind] })),
);

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

export function getKindSpec(kind: NotificationKind): NotificationKindSpec {
  return { kind, ...SPECS[kind] };
}

export function isMarketingKind(kind: NotificationKind): boolean {
  return SPECS[kind].marketing || MARKETING_NOTIFICATION_KINDS.includes(kind);
}

/** True when a member may disable the kind in preferences. */
export function canOptOut(kind: NotificationKind): boolean {
  return SPECS[kind].optOut;
}

export function defaultChannelFor(kind: NotificationKind): NotificationChannel {
  return SPECS[kind].defaultChannel;
}

/**
 * Keys inside Notification.data reserved for the module. `_dedupeKey` held NotifyInput.dedupeKey
 * before the `notifications.dedupe_key` column existed (the 20261101120000 migration moved it);
 * it is still stripped from API responses and push payloads in case an old row carries it.
 */
export const RESERVED_DATA_KEYS = Object.freeze({ dedupeKey: '_dedupeKey' });

/** Notification.dedupeKey is VarChar(200). */
export const MAX_DEDUPE_KEY_LENGTH = 200;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Public view of a stored `data` column: a plain object without reserved keys. */
export function publicData(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== RESERVED_DATA_KEYS.dedupeKey) {
      result[key] = entry;
    }
  }
  return result;
}
