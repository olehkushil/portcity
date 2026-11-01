/**
 * Outbox event catalogue: type names and payload shapes for every event a module may publish
 * (brief section 3). A new event needs a consumer route or an entry in
 * src/common/outbox/audit-only-events.ts (test/e2e/outbox-routes.e2e-spec.ts enforces it).
 *
 * Rules:
 * - names are `<aggregate>.<event>` or `<aggregate>.<sub>.<event>`, lowercase, see
 *   OUTBOX_EVENT_TYPE_PATTERN in src/common/outbox/outbox.types.ts;
 * - payloads are small JSON objects (ids and facts the consumer needs), dates as ISO strings;
 * - a consumer registers `OutboxRouter.addRoute(type, QUEUES.x)` and handles `Job<OutboxJobData>`
 *   idempotently by `eventId`;
 * - publish with `outbox.publish(tx, buildOutboxEvent(RECEIPT_EVENTS.credited, OUTBOX_AGGREGATES.receipt, id, payload))`.
 */
import type { PointsSourceType, PointsTxState, PointsTxType } from './club';
import type { FiscalNumberStatus } from './content';
import type { Platform, ProfileField } from './identity';
import type { NotificationChannel, NotificationKind } from './notifications';
import type {
  ParkingSessionSource,
  ParkingSessionStatus,
  ParkingZone,
  VehicleVerifiedVia,
} from './parking';
import type { PaymentProvider, PaymentPurpose, PaymentStatus } from './payments';
import type { ReceiptSource, ReceiptStatus, RiskFlag } from './receipts';
import type { VoucherKind, VoucherSourceType } from './rewards';
import type { IsoDateTime, Kopecks, Points, Uuid } from './shared';

/** Values for OutboxEvent.aggregateType. */
export const OUTBOX_AGGREGATES = {
  user: 'user',
  device: 'device',
  loyaltyAccount: 'loyalty_account',
  pointsTransaction: 'points_transaction',
  tenant: 'tenant',
  fiscalNumber: 'fiscal_number',
  receipt: 'receipt',
  reward: 'reward',
  redemption: 'redemption',
  voucher: 'voucher',
  promo: 'promo',
  event: 'event',
  eventRegistration: 'event_registration',
  vehicle: 'vehicle',
  parkingSession: 'parking_session',
  payment: 'payment',
  notification: 'notification',
  manualAdjustment: 'manual_adjustment',
  featureFlag: 'feature_flag',
  supportRequest: 'support_request',
} as const;
export type OutboxAggregateType = (typeof OUTBOX_AGGREGATES)[keyof typeof OUTBOX_AGGREGATES];

// ---------------------------------------------------------------------------
// Event names per producing module
// ---------------------------------------------------------------------------

export const IDENTITY_EVENTS = {
  registered: 'user.registered',
  profileCompleted: 'user.profile_completed',
  deviceRegistered: 'user.device_registered',
  blocked: 'user.blocked',
  deletionRequested: 'user.deletion_requested',
  /** DELETE /me/deletion during the cooling-off period. */
  deletionCancelled: 'user.deletion_cancelled',
  deleted: 'user.deleted',
  /** POST /admin/users/:id/unblock. */
  unblocked: 'user.unblocked',
  /** A profile field (PROFILE_FIELDS) was filled for the first time; club awards the field bonus. */
  profileFieldCompleted: 'user.profile_field_completed',
} as const;

export const CLUB_EVENTS = {
  accountCreated: 'points.account_created',
  credited: 'points.credited',
  held: 'points.held',
  released: 'points.released',
  spent: 'points.spent',
  reversed: 'points.reversed',
  expiring: 'points.expiring',
  expired: 'points.expired',
} as const;

export const CONTENT_EVENTS = {
  tenantUpdated: 'tenant.updated',
  fiscalNumberSeen: 'tenant.fiscal_number_seen',
  fiscalNumberConfirmed: 'tenant.fiscal_number_confirmed',
} as const;

export const RECEIPT_EVENTS = {
  submitted: 'receipt.submitted',
  needsModeration: 'receipt.needs_moderation',
  approved: 'receipt.approved',
  rejected: 'receipt.rejected',
  credited: 'receipt.credited',
  appealed: 'receipt.appealed',
} as const;

export const REWARD_EVENTS = {
  redemptionCreated: 'redemption.created',
  voucherIssued: 'voucher.issued',
  voucherActivated: 'voucher.activated',
  voucherRedeemed: 'voucher.redeemed',
  voucherExpired: 'voucher.expired',
  voucherCancelled: 'voucher.cancelled',
} as const;

export const PROMO_EVENTS = {
  published: 'promo.published',
  couponClaimed: 'promo.coupon_claimed',
  eventRegistered: 'event.registered',
  eventRegistrationCancelled: 'event.registration_cancelled',
  eventCancelled: 'event.cancelled',
  /** POST /admin/events/:id/publish: announced to members with the marketing consent. */
  eventPublished: 'event.published',
} as const;

export const PARKING_EVENTS = {
  sessionOpened: 'parking.session.opened',
  sessionPayable: 'parking.session.payable',
  sessionPaid: 'parking.session.paid',
  sessionOverstay: 'parking.session.overstay',
  sessionClosed: 'parking.session.closed',
  vehicleVerified: 'parking.vehicle.verified',
  /** Reminder F2: the free period ends in PARKING_FREE_ENDING_REMINDER_MINUTES (5). */
  sessionFreeEnding: 'parking.session.free_ending',
  /** Reminder F4: the paid period ends in PARKING_EXIT_REMINDER_MINUTES (10). */
  sessionExitSoon: 'parking.session.exit_soon',
  /** Reminder F7: payable 5 h after entry or overstaying 2 h after paidUntil. */
  sessionStillInside: 'parking.session.still_inside',
  /** F2 «Це не моє авто» and other member disputes (POST /parking/session/:id/dispute). */
  sessionDisputed: 'parking.session.disputed',
  /** Ops alert: an app payment that the session cannot use (refund queued) or needs a manual look. */
  paymentOpsAlert: 'parking.payment.ops_alert',
} as const;

/** The three reminder events above, published at most once per session and reminder. */
export const PARKING_REMINDER_EVENT_TYPES = [
  PARKING_EVENTS.sessionFreeEnding,
  PARKING_EVENTS.sessionExitSoon,
  PARKING_EVENTS.sessionStillInside,
] as const;
export type ParkingReminderKind = 'free_ending' | 'exit_soon' | 'still_inside';

export const PAYMENT_EVENTS = {
  created: 'payment.created',
  succeeded: 'payment.succeeded',
  failed: 'payment.failed',
  cancelled: 'payment.cancelled',
  expired: 'payment.expired',
  refunded: 'payment.refunded',
  fiscalized: 'payment.fiscalized',
} as const;

export const NOTIFICATION_EVENTS = {
  created: 'notification.created',
} as const;

export const ADMIN_EVENTS = {
  adjustmentRequested: 'adjustment.requested',
  adjustmentApproved: 'adjustment.approved',
  adjustmentApplied: 'adjustment.applied',
  adjustmentRejected: 'adjustment.rejected',
  flagUpdated: 'flag.updated',
  /** POST /support/requests: e-mail to SUPPORT_EMAIL and an in-app confirmation (notifications). */
  supportRequestCreated: 'support.request_created',
} as const;

// ---------------------------------------------------------------------------
// Payloads (type aliases, not interfaces, so they satisfy OutboxPayload = Record<string, unknown>)
// ---------------------------------------------------------------------------

export type UserRegisteredPayload = {
  userId: Uuid;
  memberCode: string;
  deviceId: Uuid | null;
  registeredAt: IsoDateTime;
};
export type UserProfileCompletedPayload = { userId: Uuid; completedAt: IsoDateTime };
export type UserDeviceRegisteredPayload = {
  userId: Uuid;
  deviceId: Uuid;
  platform: Platform;
  pushEnabled: boolean;
};
export type UserBlockedPayload = { userId: Uuid; reason: string | null };
export type UserDeletionRequestedPayload = {
  userId: Uuid;
  requestId: Uuid;
  executeAfter: IsoDateTime;
};
export type UserDeletionCancelledPayload = {
  userId: Uuid;
  requestId: Uuid;
  cancelledAt: IsoDateTime;
};
export type UserDeletedPayload = { userId: Uuid; requestId: Uuid; deletedAt: IsoDateTime };
export type UserUnblockedPayload = { userId: Uuid; reason: string | null };
/**
 * Published once per member and field (PROFILE_FIELDS in ./identity), in the transaction that
 * fills the field for the first time. `allFieldsCompleted` is true on the event that completes
 * the last of the seven fields (trigger for the "profile complete" bonus).
 */
export type UserProfileFieldCompletedPayload = {
  userId: Uuid;
  field: ProfileField;
  completedAt: IsoDateTime;
  allFieldsCompleted: boolean;
};

export type PointsAccountCreatedPayload = { userId: Uuid; accountId: Uuid };
export type PointsCreditedPayload = {
  userId: Uuid;
  accountId: Uuid;
  txId: Uuid;
  type: PointsTxType;
  state: PointsTxState;
  amount: Points;
  sourceType: PointsSourceType;
  sourceId: Uuid | null;
  availableAt: IsoDateTime | null;
  expiresAt: IsoDateTime | null;
  availableBalance: Points;
};
export type PointsHeldPayload = PointsCreditedPayload;
export type PointsReleasedPayload = {
  userId: Uuid;
  accountId: Uuid;
  txId: Uuid;
  amount: Points;
  availableBalance: Points;
};
export type PointsSpentPayload = {
  userId: Uuid;
  accountId: Uuid;
  txId: Uuid;
  /** Positive number of points taken. */
  amount: Points;
  sourceType: PointsSourceType;
  sourceId: Uuid | null;
  availableBalance: Points;
};
export type PointsReversedPayload = {
  userId: Uuid;
  accountId: Uuid;
  txId: Uuid;
  reversedTxId: Uuid;
  /** Signed effect on the available balance (0 when a pending hold was cancelled). */
  amount: Points;
  /** Pending points withdrawn by cancelling a hold; 0 or absent when the available balance moved. */
  pendingAmount?: Points;
  reason: string;
  availableBalance: Points;
};
export type PointsExpiringPayload = {
  userId: Uuid;
  accountId: Uuid;
  points: Points;
  /** `yyyy-MM-dd` (Kyiv). */
  expiresOn: string;
  daysLeft: number;
};
export type PointsExpiredPayload = {
  userId: Uuid;
  accountId: Uuid;
  points: Points;
  expiredOn: string;
  availableBalance: Points;
};

export type TenantUpdatedPayload = { tenantId: Uuid; slug: string; changedFields: string[] };
export type FiscalNumberSeenPayload = { fn: string; receiptId: Uuid | null };
export type FiscalNumberConfirmedPayload = {
  fn: string;
  tenantId: Uuid | null;
  status: FiscalNumberStatus;
  confirmedById: Uuid | null;
};

export type ReceiptSubmittedPayload = {
  receiptId: Uuid;
  userId: Uuid;
  deviceId: Uuid | null;
  fn: string;
  fiscalId: string;
  totalKopecks: Kopecks;
  issuedAt: IsoDateTime;
  source: ReceiptSource;
};
export type ReceiptNeedsModerationPayload = {
  receiptId: Uuid;
  userId: Uuid;
  tenantId: Uuid | null;
  totalKopecks: Kopecks;
  riskFlags: RiskFlag[];
  riskScore: number;
};
export type ReceiptApprovedPayload = {
  receiptId: Uuid;
  userId: Uuid;
  moderatorId: Uuid | null;
};
export type ReceiptRejectedPayload = {
  receiptId: Uuid;
  userId: Uuid;
  moderatorId: Uuid | null;
  reason: string;
  code: string | null;
};
export type ReceiptCreditedPayload = {
  receiptId: Uuid;
  userId: Uuid;
  tenantId: Uuid | null;
  totalKopecks: Kopecks;
  pointsAwarded: Points;
  pointsTxId: Uuid;
  /** `pending` when the credit is held, `available` otherwise. */
  pointsState: Extract<PointsTxState, 'pending' | 'available'>;
  availableAt: IsoDateTime | null;
  /** True for the member's first credited receipt (welcome bonus trigger). */
  firstReceipt: boolean;
};
export type ReceiptAppealedPayload = {
  receiptId: Uuid;
  userId: Uuid;
  appealId: Uuid;
  previousStatus: ReceiptStatus;
};

export type RedemptionCreatedPayload = {
  redemptionId: Uuid;
  userId: Uuid;
  rewardId: Uuid;
  voucherId: Uuid;
  pointsTxId: Uuid;
  costPoints: Points;
};
export type VoucherLifecyclePayload = {
  voucherId: Uuid;
  userId: Uuid;
  kind: VoucherKind;
  title: string;
  tenantId: Uuid | null;
  sourceType: VoucherSourceType;
  sourceId: Uuid | null;
  expiresAt: IsoDateTime | null;
};
export type VoucherIssuedPayload = VoucherLifecyclePayload;
export type VoucherActivatedPayload = VoucherLifecyclePayload & {
  activationExpiresAt: IsoDateTime;
};
export type VoucherRedeemedPayload = VoucherLifecyclePayload & {
  redeemedAt: IsoDateTime;
  redeemedByDeviceId: Uuid | null;
  redeemedByTenantId: Uuid | null;
};
export type VoucherExpiredPayload = VoucherLifecyclePayload;
export type VoucherCancelledPayload = VoucherLifecyclePayload & {
  reason: string;
  pointsRefunded: Points | null;
};

export type PromoPublishedPayload = {
  promoId: Uuid;
  tenantId: Uuid | null;
  title: string;
  kind: 'info' | 'coupon';
  validTo: IsoDateTime;
};
export type CouponClaimedPayload = {
  promoId: Uuid;
  couponTemplateId: Uuid;
  userId: Uuid;
  voucherId: Uuid;
};
export type EventRegisteredPayload = {
  eventId: Uuid;
  registrationId: Uuid;
  userId: Uuid;
  adults: number;
  children: number;
  voucherId: Uuid | null;
  startsAt: IsoDateTime;
  /** Event title and venue for the confirmation; absent in events published before 2026-11. */
  title?: string;
  venue?: string | null;
};
export type EventRegistrationCancelledPayload = {
  eventId: Uuid;
  registrationId: Uuid;
  userId: Uuid;
  voucherId: Uuid | null;
};
export type EventCancelledPayload = { eventId: Uuid; title: string; registeredUserIds: Uuid[] };
export type EventPublishedPayload = {
  eventId: Uuid;
  title: string;
  /** EventCategory of the promos contract. */
  category: 'kids' | 'masterclass' | 'cinema' | 'concert' | 'other';
  tenantId: Uuid | null;
  venue: string | null;
  startsAt: IsoDateTime;
  endsAt: IsoDateTime;
  admission: 'registration' | 'external';
};

export type ParkingSessionPayload = {
  sessionId: Uuid;
  userId: Uuid | null;
  vehicleId: Uuid | null;
  plate: string | null;
  zone: ParkingZone;
  status: ParkingSessionStatus;
  enteredAt: IsoDateTime;
};
export type ParkingSessionOpenedPayload = ParkingSessionPayload;
export type ParkingSessionPayablePayload = ParkingSessionPayload & {
  amountDueKopecks: Kopecks;
  currentHourEndsAt: IsoDateTime;
};
export type ParkingSessionPaidPayload = ParkingSessionPayload & {
  paymentId: Uuid | null;
  amountPaidKopecks: Kopecks;
  paidUntil: IsoDateTime;
};
export type ParkingSessionOverstayPayload = ParkingSessionPayload & {
  paidUntil: IsoDateTime | null;
  amountDueKopecks: Kopecks;
};
export type ParkingSessionClosedPayload = ParkingSessionPayload & {
  exitedAt: IsoDateTime;
  closedReason: string | null;
  amountPaidKopecks: Kopecks;
};
/** Payload of the three reminder events (parking.session.free_ending|exit_soon|still_inside). */
export type ParkingSessionReminderPayload = ParkingSessionPayload & {
  reminder: ParkingReminderKind;
  /** End of the free period (free_ending), paidUntil (exit_soon) or the F7 threshold (still_inside). */
  deadline: IsoDateTime;
  minutesLeft: number;
  source: ParkingSessionSource;
  amountDueKopecks: Kopecks;
  paidUntil: IsoDateTime | null;
};
export type ParkingVehicleVerifiedPayload = {
  vehicleId: Uuid;
  userId: Uuid;
  plate: string;
  verifiedVia: VehicleVerifiedVia;
};
export type ParkingSessionDisputedPayload = ParkingSessionPayload & {
  /** `not_my_car` | `wrong_amount` | `barrier` (PARKING_DISPUTE_REASONS). */
  reason: string;
  comment: string | null;
  disputedAt: IsoDateTime;
};
export type ParkingPaymentOpsAlertPayload = {
  /** `refund_queued`: the payment cannot be used and is refunded automatically; `manual_review`: money kept, ops must look. */
  alert: 'refund_queued' | 'manual_review';
  /** `session_not_found` | `session_closed` | `session_closed_unpaid` | `already_paid`. */
  reason: string;
  paymentId: Uuid;
  sessionId: Uuid | null;
  userId: Uuid;
  amountKopecks: Kopecks;
  /** The payment succeeded after it had expired, failed or been cancelled. */
  late: boolean;
  paidUntil: IsoDateTime | null;
  /** Outcome of PaymentsPort.requestRefund, null when no refund was asked for. */
  refund: 'queued' | 'already_queued' | 'not_refundable' | null;
};

export type PaymentPayload = {
  paymentId: Uuid;
  userId: Uuid;
  purpose: PaymentPurpose;
  amountKopecks: Kopecks;
  provider: PaymentProvider;
  providerRef: string | null;
  status: PaymentStatus;
  /** CreatePaymentInput.meta echoed back, e.g. `{ sessionId }`. */
  meta: Record<string, unknown>;
};
export type PaymentCreatedPayload = PaymentPayload;
export type PaymentSucceededPayload = PaymentPayload & {
  paidAt: IsoDateTime;
  /** True when the provider captured the money after the payment had expired, failed or been cancelled. */
  late?: boolean;
};
export type PaymentFailedPayload = PaymentPayload & { failureCode: string | null };
export type PaymentCancelledPayload = PaymentPayload;
export type PaymentExpiredPayload = PaymentPayload;
export type PaymentRefundedPayload = PaymentPayload & {
  refundedKopecks: Kopecks;
  partial: boolean;
};
export type PaymentFiscalizedPayload = PaymentPayload & { fiscalReceiptUrl: string | null };

export type NotificationCreatedPayload = {
  notificationId: Uuid;
  userId: Uuid;
  kind: NotificationKind;
  channel: NotificationChannel;
};

export type AdjustmentPayload = {
  adjustmentId: Uuid;
  accountId: Uuid;
  userId: Uuid;
  amount: Points;
  reason: string;
  requestedById: Uuid;
};
export type AdjustmentRequestedPayload = AdjustmentPayload & { needsSecondApproval: boolean };
export type AdjustmentApprovedPayload = AdjustmentPayload & { approvedById: Uuid };
export type AdjustmentAppliedPayload = AdjustmentPayload & { pointsTxId: Uuid };
export type AdjustmentRejectedPayload = AdjustmentPayload & {
  rejectedById: Uuid;
  rejectionReason: string;
};
export type FlagUpdatedPayload = { key: string; enabled: boolean; updatedById: Uuid | null };
export type SupportRequestCreatedPayload = {
  requestId: Uuid;
  /** Human number shown to the member (№ 1042). */
  number: number;
  userId: Uuid;
  topic: 'receipt' | 'parking' | 'voucher' | 'other';
  relatedType: string | null;
  relatedId: string | null;
  /** The member's text (personal data; the outbox row is purged after 7 days). */
  message: string;
  photoKey: string | null;
  createdAt: IsoDateTime;
};

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** Event type -> payload. Adding an event means adding it here and to the module's constant. */
export interface OutboxEventPayloads {
  'user.registered': UserRegisteredPayload;
  'user.profile_completed': UserProfileCompletedPayload;
  'user.device_registered': UserDeviceRegisteredPayload;
  'user.blocked': UserBlockedPayload;
  'user.deletion_requested': UserDeletionRequestedPayload;
  'user.deletion_cancelled': UserDeletionCancelledPayload;
  'user.deleted': UserDeletedPayload;
  'user.unblocked': UserUnblockedPayload;
  'user.profile_field_completed': UserProfileFieldCompletedPayload;

  'points.account_created': PointsAccountCreatedPayload;
  'points.credited': PointsCreditedPayload;
  'points.held': PointsHeldPayload;
  'points.released': PointsReleasedPayload;
  'points.spent': PointsSpentPayload;
  'points.reversed': PointsReversedPayload;
  'points.expiring': PointsExpiringPayload;
  'points.expired': PointsExpiredPayload;

  'tenant.updated': TenantUpdatedPayload;
  'tenant.fiscal_number_seen': FiscalNumberSeenPayload;
  'tenant.fiscal_number_confirmed': FiscalNumberConfirmedPayload;

  'receipt.submitted': ReceiptSubmittedPayload;
  'receipt.needs_moderation': ReceiptNeedsModerationPayload;
  'receipt.approved': ReceiptApprovedPayload;
  'receipt.rejected': ReceiptRejectedPayload;
  'receipt.credited': ReceiptCreditedPayload;
  'receipt.appealed': ReceiptAppealedPayload;

  'redemption.created': RedemptionCreatedPayload;
  'voucher.issued': VoucherIssuedPayload;
  'voucher.activated': VoucherActivatedPayload;
  'voucher.redeemed': VoucherRedeemedPayload;
  'voucher.expired': VoucherExpiredPayload;
  'voucher.cancelled': VoucherCancelledPayload;

  'promo.published': PromoPublishedPayload;
  'promo.coupon_claimed': CouponClaimedPayload;
  'event.registered': EventRegisteredPayload;
  'event.registration_cancelled': EventRegistrationCancelledPayload;
  'event.cancelled': EventCancelledPayload;
  'event.published': EventPublishedPayload;

  'parking.session.opened': ParkingSessionOpenedPayload;
  'parking.session.payable': ParkingSessionPayablePayload;
  'parking.session.paid': ParkingSessionPaidPayload;
  'parking.session.overstay': ParkingSessionOverstayPayload;
  'parking.session.closed': ParkingSessionClosedPayload;
  'parking.vehicle.verified': ParkingVehicleVerifiedPayload;
  'parking.session.free_ending': ParkingSessionReminderPayload;
  'parking.session.exit_soon': ParkingSessionReminderPayload;
  'parking.session.still_inside': ParkingSessionReminderPayload;
  'parking.session.disputed': ParkingSessionDisputedPayload;
  'parking.payment.ops_alert': ParkingPaymentOpsAlertPayload;

  'payment.created': PaymentCreatedPayload;
  'payment.succeeded': PaymentSucceededPayload;
  'payment.failed': PaymentFailedPayload;
  'payment.cancelled': PaymentCancelledPayload;
  'payment.expired': PaymentExpiredPayload;
  'payment.refunded': PaymentRefundedPayload;
  'payment.fiscalized': PaymentFiscalizedPayload;

  'notification.created': NotificationCreatedPayload;

  'adjustment.requested': AdjustmentRequestedPayload;
  'adjustment.approved': AdjustmentApprovedPayload;
  'adjustment.applied': AdjustmentAppliedPayload;
  'adjustment.rejected': AdjustmentRejectedPayload;
  'flag.updated': FlagUpdatedPayload;
  'support.request_created': SupportRequestCreatedPayload;
}

export type OutboxEventType = keyof OutboxEventPayloads;

/** Every known event type; the spec asserts it matches the catalogue exactly. */
export const ALL_OUTBOX_EVENT_TYPES: readonly OutboxEventType[] = Object.freeze([
  ...Object.values(IDENTITY_EVENTS),
  ...Object.values(CLUB_EVENTS),
  ...Object.values(CONTENT_EVENTS),
  ...Object.values(RECEIPT_EVENTS),
  ...Object.values(REWARD_EVENTS),
  ...Object.values(PROMO_EVENTS),
  ...Object.values(PARKING_EVENTS),
  ...Object.values(PAYMENT_EVENTS),
  ...Object.values(NOTIFICATION_EVENTS),
  ...Object.values(ADMIN_EVENTS),
]);

export function isOutboxEventType(value: string): value is OutboxEventType {
  return (ALL_OUTBOX_EVENT_TYPES as readonly string[]).includes(value);
}

/** What `OutboxService.publish(tx, event)` accepts, narrowed to a catalogue type. */
export interface TypedOutboxEventInput<T extends OutboxEventType = OutboxEventType> {
  aggregateType: OutboxAggregateType;
  aggregateId: Uuid;
  type: T;
  payload: OutboxEventPayloads[T];
  occurredAt?: Date;
}

/** What a consumer receives as `Job<OutboxJobData>.data`, narrowed to a catalogue type. */
export interface TypedOutboxEvent<T extends OutboxEventType = OutboxEventType> {
  eventId: Uuid;
  type: T;
  aggregateType: string;
  aggregateId: string;
  payload: OutboxEventPayloads[T];
  occurredAt: IsoDateTime;
}

/** Type-safe constructor for `outbox.publish(tx, ...)`. */
export function buildOutboxEvent<T extends OutboxEventType>(
  type: T,
  aggregateType: OutboxAggregateType,
  aggregateId: Uuid,
  payload: OutboxEventPayloads[T],
  occurredAt?: Date,
): TypedOutboxEventInput<T> {
  return occurredAt
    ? { aggregateType, aggregateId, type, payload, occurredAt }
    : { aggregateType, aggregateId, type, payload };
}
