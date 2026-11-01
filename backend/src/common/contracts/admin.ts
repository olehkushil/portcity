/**
 * Admin contract: the audit trail and feature flags every module uses, plus the manual
 * adjustment vocabulary.
 *
 * ADMIN_AUDIT_PORT and FEATURE_FLAGS_PORT are implemented in the common layer
 * (`src/common/audit`, `src/common/feature-flags`, both global) because their tables live in
 * `base.prisma` and every module needs them; the admin module consumes them like everyone
 * else and hosts the read endpoints (GET /admin/audit, feature flag CRUD, reports).
 */
import type { ActorRef, Tx, Uuid } from './shared';

export const ADMIN_AUDIT_PORT = Symbol('ADMIN_AUDIT_PORT');
export const FEATURE_FLAGS_PORT = Symbol('FEATURE_FLAGS_PORT');

/** Audit actions are `<entity>.<verb>` in lowercase, e.g. `tenant.update`, `receipt.approve`. */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export interface AuditEntry {
  actor: ActorRef;
  /** `<entity>.<verb>`, see AUDIT_ACTION_PATTERN. */
  action: string;
  /** Prisma model name in snake_case, e.g. `tenant`, `receipt`, `manual_adjustment`. */
  entityType: string;
  /** Usually a Uuid; natural keys (feature flag key, fiscal number) are allowed. */
  entityId?: string | null;
  /** JSON-serialisable snapshots; omit what did not change. */
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
}

export interface AuditLogEntry extends AuditEntry {
  id: Uuid;
  createdAt: Date;
}

export interface AdminAuditPort {
  /** Appends an audit row (in the caller's transaction when `tx` is given) and returns its id. */
  audit(entry: AuditEntry, tx?: Tx): Promise<Uuid>;
}

/** Keys seeded by prisma/seed.ts; add new keys here so every module uses the same spelling. */
export const FEATURE_FLAG_KEYS = {
  parkingInfoMode: 'parking.info_mode',
  receiptsManualSubmission: 'receipts.manual_submission',
  eventsRegistration: 'events.registration',
  /**
   * Air-raid alert switched on by the duty officer (design brief 4.3): entry closed, exit free
   * during the first minutes of the alert. Payload: ParkingAirRaidFlagPayload. Seeded disabled.
   */
  parkingAirRaid: 'parking.air_raid',
} as const;
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[keyof typeof FEATURE_FLAG_KEYS];

/** Payload of the `parking.air_raid` flag; both fields are optional. */
export interface ParkingAirRaidFlagPayload {
  /** ISO start of the alert; defaults to the moment the flag was switched on. */
  startedAt?: string;
  /** Overrides PARKING_AIR_RAID_FREE_EXIT_MINUTES (operator's rule: 30). */
  freeExitMinutes?: number;
}

export interface FeatureFlagView {
  key: string;
  enabled: boolean;
  payload: Record<string, unknown> | null;
  updatedAt: Date;
}

export interface FeatureFlagsPort {
  /** `fallback` is returned when the flag row does not exist. Keys: FEATURE_FLAG_KEYS. */
  isEnabled(key: string, fallback?: boolean): Promise<boolean>;
  get(key: string): Promise<FeatureFlagView | null>;
}

export const MANUAL_ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected', 'applied'] as const;
export type ManualAdjustmentStatus = (typeof MANUAL_ADJUSTMENT_STATUSES)[number];

/**
 * Absolute amount above which a second admin must approve a manual adjustment (brief section 4).
 * The same threshold caps the cumulative self-approved amount per requester per Kyiv day and per
 * target account over a rolling 24 hours.
 */
export const FOUR_EYES_THRESHOLD_POINTS = 500;

/** Support requests ("Звернення"): topics of the prototype form (Чек, Паркінг, Ваучер, Інше). */
export const SUPPORT_REQUEST_TOPICS = ['receipt', 'parking', 'voucher', 'other'] as const;
export type SupportRequestTopic = (typeof SUPPORT_REQUEST_TOPICS)[number];

export const SUPPORT_REQUEST_STATUSES = ['new', 'in_progress', 'resolved', 'closed'] as const;
export type SupportRequestStatus = (typeof SUPPORT_REQUEST_STATUSES)[number];

/** What a support request may point at (relatedType). */
export const SUPPORT_RELATED_TYPES = [
  'receipt',
  'parking_session',
  'voucher',
  'payment',
  'event_registration',
  'other',
] as const;
export type SupportRelatedType = (typeof SUPPORT_RELATED_TYPES)[number];

/** Requests one member may create per Kyiv calendar day. */
export const SUPPORT_REQUESTS_PER_DAY = 5;

export const ADMIN_ERROR_CODES = [
  'PC_ADJUSTMENT_NOT_FOUND',
  'PC_ADJUSTMENT_INVALID_TRANSITION',
  'PC_ADJUSTMENT_SELF_APPROVAL',
  'PC_ADJUSTMENT_APPROVAL_REQUIRED',
  'PC_FEATURE_FLAG_NOT_FOUND',
  'PC_AUDIT_ACTION_INVALID',
  'PC_REPORT_NOT_READY',
  /** 422: amount is 0, not an integer or outside +-1 000 000. */
  'PC_ADJUSTMENT_AMOUNT_INVALID',
  /** 404: the user has no loyalty account yet. */
  'PC_ADJUSTMENT_ACCOUNT_NOT_FOUND',
  /** 400: key is not shaped like `parking.info_mode`. */
  'PC_FEATURE_FLAG_KEY_INVALID',
  /** 400: day is not `yyyy-MM-dd` or the range is reversed or too long. */
  'PC_REPORT_DAY_INVALID',
  /** 404: support request not found (or not the member's own). */
  'PC_SUPPORT_REQUEST_NOT_FOUND',
  /** 409: the status change is not allowed (e.g. a closed request). */
  'PC_SUPPORT_REQUEST_INVALID_TRANSITION',
  /** 429: the member already sent SUPPORT_REQUESTS_PER_DAY requests today (Kyiv). */
  'PC_SUPPORT_REQUEST_DAILY_LIMIT',
  /** 422: photoKey is not an upload of this member, or the upload content type/size is refused. */
  'PC_SUPPORT_REQUEST_PHOTO_INVALID',
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];
