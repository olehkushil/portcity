/**
 * Identity contract: what other modules may ask the identity module (users, devices,
 * consents, member codes). Implemented by `src/modules/identity`, provided under IDENTITY_PORT.
 * Consumers: club (member code for the card), notifications (push devices, consents), admin.
 */
import type { Tx, Uuid } from './shared';

export const IDENTITY_PORT = Symbol('IDENTITY_PORT');

export const USER_STATUSES = ['active', 'blocked', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PLATFORMS = ['ios', 'android', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CONSENT_PURPOSES = ['program', 'marketing', 'profiling'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** 9 decimal digits, unique per member, printed on the club card. */
export const MEMBER_CODE_LENGTH = 9;
export const MEMBER_CODE_PATTERN = /^\d{9}$/;

/**
 * Default cooling-off period between a deletion request and its execution (brief section 4).
 * The effective value is `ACCOUNT_DELETION_GRACE_DAYS` (identity env section, default 30).
 */
export const ACCOUNT_DELETION_DELAY_DAYS = 30;

/** Member / child gender (profile). `unspecified` is an explicit "prefer not to say" answer. */
export const GENDERS = ['female', 'male', 'other', 'unspecified'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * Profile fields that count towards `profileCompletion` on `GET /me`. The first time a member fills
 * one, identity publishes `user.profile_field_completed { userId, field }` (once per field and
 * member, even if the field is cleared and filled again); `children` counts as filled with at
 * least one child.
 */
export const PROFILE_FIELDS = [
  'firstName',
  'lastName',
  'birthDate',
  'email',
  'gender',
  'city',
  'children',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface UserSummary {
  id: Uuid;
  /** E.164, e.g. `+380501234567`; a placeholder for anonymised accounts. */
  phone: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** `yyyy-MM-dd` or null. */
  birthDate: string | null;
  status: UserStatus;
  memberCode: string;
  profileCompletedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface DeviceSummary {
  id: Uuid;
  userId: Uuid;
  platform: Platform;
  model: string | null;
  appVersion: string | null;
  fingerprint: string | null;
  pushToken: string | null;
  pushEnabled: boolean;
  lastSeenAt: Date | null;
}

/** Back-office roles (same values as the AdminRole enum in prisma/schema/identity.prisma). */
export type AdminAccessRole = 'owner' | 'manager' | 'moderator' | 'support' | 'validator';

/** What the shared AdminGuard needs to know about an admin behind a still-valid token. */
export interface AdminAccess {
  active: boolean;
  role: AdminAccessRole;
}

/** One page of the marketing audience (`listMarketingAudience`). */
export interface MarketingAudiencePage {
  userIds: Uuid[];
  /** Pass back as `cursor` for the next page; null when this was the last page. */
  nextCursor: Uuid | null;
}

export interface IdentityPort {
  /** Null when the user does not exist; deleted/blocked users are returned with their status. */
  getUser(userId: Uuid, tx?: Tx): Promise<UserSummary | null>;
  /** Batch lookup; missing ids are omitted, order is not guaranteed. */
  getUsers(userIds: readonly Uuid[]): Promise<UserSummary[]>;
  getDevice(deviceId: Uuid): Promise<DeviceSummary | null>;
  /** Resolves the 9-digit code from a club card or QR to its (active or not) owner. */
  resolveMemberCode(memberCode: string): Promise<UserSummary | null>;
  /** Devices that may receive push: `pushEnabled` with a non-null `pushToken`. */
  listPushDevices(userId: Uuid): Promise<DeviceSummary[]>;
  /** True when the latest consent for the purpose is granted and not revoked. */
  hasConsent(userId: Uuid, purpose: ConsentPurpose): Promise<boolean>;
  /**
   * Active members whose latest `marketing` consent is granted and not revoked, ordered by id;
   * `cursor` is the last user id of the previous page (null for the first page). Used by the
   * notifications module to fan out `promo.published` broadcasts.
   */
  listMarketingAudience(cursor: Uuid | null, limit: number): Promise<MarketingAudiencePage>;
  /**
   * Current state of a back-office account (null when it does not exist). The shared AdminGuard
   * calls it (with a short in-memory cache) so deactivated admins and changed roles lose access
   * before their stateless access token expires.
   */
  getAdminAccess(adminId: Uuid): Promise<AdminAccess | null>;
}

/** Error codes the identity module registers with `defineErrorCodes` (names reserved here). */
export const IDENTITY_ERROR_CODES = [
  'PC_OTP_INVALID',
  'PC_OTP_EXPIRED',
  'PC_OTP_TOO_MANY_ATTEMPTS',
  'PC_OTP_RATE_LIMITED',
  'PC_REFRESH_INVALID',
  'PC_REFRESH_REUSED',
  'PC_USER_NOT_FOUND',
  'PC_USER_BLOCKED',
  'PC_USER_DELETED',
  'PC_USER_EMAIL_TAKEN',
  'PC_DEVICE_NOT_FOUND',
  'PC_ADMIN_CREDENTIALS_INVALID',
  'PC_ADMIN_TOTP_REQUIRED',
  'PC_ADMIN_TOTP_INVALID',
  'PC_ADMIN_INACTIVE',
  // Registered by the module during the build phase (integration, 2026-11-01).
  'PC_OTP_DELIVERY_FAILED',
  'PC_USER_BIRTHDATE_INVALID',
  'PC_USER_INVALID_TRANSITION',
  'PC_CONSENT_PROGRAM_REQUIRED',
  'PC_DELETION_NOT_PENDING',
  'PC_ADMIN_CHALLENGE_INVALID',
  'PC_ADMIN_NOT_FOUND',
  'PC_ADMIN_EMAIL_TAKEN',
  'PC_ADMIN_LAST_OWNER',
  'PC_ADMIN_SELF_ACTION',
  'PC_ADMIN_TOTP_ALREADY_ENABLED',
  'PC_ADMIN_TOTP_NOT_ENABLED',
  // Security and profile review fixes (2026-11-01).
  'PC_OTP_LOCKED',
  'PC_OTP_CAPTCHA_REQUIRED',
  'PC_OTP_SMS_BUDGET_EXHAUSTED',
  'PC_USER_CHILD_NOT_FOUND',
  'PC_USER_CHILD_LIMIT',
  'PC_USER_CHILD_BIRTH_INVALID',
  'PC_ADMIN_TOTP_SETUP_REQUIRED',
  'PC_ADMIN_TOTP_REQUIRED_FOR_ROLE',
  'PC_ADMIN_LOGIN_LOCKED',
  'PC_ADMIN_LOGIN_BUSY',
] as const;
export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];
