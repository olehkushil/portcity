/**
 * Notifications contract: create an in-app notification (and a push when the channel allows).
 * Implemented by `src/modules/notifications`, provided under NOTIFICATIONS_PORT.
 * Most notifications are produced by the notifications module's own outbox consumers; the port
 * exists for synchronous callers (admin tools, jobs that already know the recipient).
 */
import type { Tx, Uuid } from './shared';

export const NOTIFICATIONS_PORT = Symbol('NOTIFICATIONS_PORT');

export const NOTIFICATION_CHANNELS = ['inapp', 'push', 'both'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const PUSH_DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type PushDeliveryStatus = (typeof PUSH_DELIVERY_STATUSES)[number];

/**
 * Kind registry (Notification.kind and NotificationPreference.kind are plain strings).
 * Marketing kinds require the `marketing` consent; the rest are service notifications.
 */
export const NOTIFICATION_KINDS = [
  'receipt_credited',
  'receipt_held',
  'receipt_needs_moderation',
  'receipt_approved',
  'receipt_rejected',
  'points_released',
  'points_expiring',
  'points_expired',
  'points_adjusted',
  'voucher_issued',
  'voucher_redeemed',
  'voucher_expiring',
  'voucher_cancelled',
  'ticket_reminder',
  'event_registered',
  'event_published',
  'parking_opened',
  'parking_free_ending',
  'parking_payable',
  'parking_paid',
  'parking_exit_soon',
  'parking_overstay',
  'parking_still_inside',
  'parking_closed',
  'parking_disputed',
  'payment_succeeded',
  'payment_failed',
  /** payment.refunded of a parking payment (automatic refund or back office). */
  'payment_refunded',
  'account_deletion_scheduled',
  'account_deletion_cancelled',
  'promo_published',
  'support_request_received',
  'system',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Registry order (the kinds spec compares the marketing subset in this order). */
export const MARKETING_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'event_published',
  'promo_published',
];

export interface NotificationSummary {
  id: Uuid;
  userId: Uuid;
  kind: NotificationKind;
  title: string;
  body: string;
  data: Record<string, unknown>;
  channel: NotificationChannel;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotifyInput {
  userId: Uuid;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Deep-link context for the app, e.g. `{ receiptId }`. */
  data?: Record<string, unknown>;
  /** Defaults to `both`. */
  channel?: NotificationChannel;
  /** Prevents duplicates (e.g. the outbox event id): a replay returns the existing notification. */
  dedupeKey?: string;
}

export interface NotificationsPort {
  /**
   * Stores the in-app notification and publishes `notification.created`, which the
   * notifications-push queue turns into push deliveries. Returns null when the user's
   * preference for the kind is disabled or a marketing kind lacks consent.
   */
  notify(input: NotifyInput, tx?: Tx): Promise<NotificationSummary | null>;
  countUnread(userId: Uuid): Promise<number>;
}

export const NOTIFICATIONS_ERROR_CODES = [
  'PC_NOTIFICATION_NOT_FOUND',
  'PC_NOTIFICATION_KIND_UNKNOWN',
  'PC_PUSH_PROVIDER_UNAVAILABLE',
  /** 422: service kinds (payments, account, system) cannot be switched off. */
  'PC_NOTIFICATION_PREFERENCE_LOCKED',
] as const;
export type NotificationsErrorCode = (typeof NOTIFICATIONS_ERROR_CODES)[number];
