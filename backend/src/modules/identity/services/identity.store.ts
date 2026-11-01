import type {
  AccountDeletionRequest,
  AdminRole,
  AdminUser,
  Child,
  Consent,
  ConsentPurpose,
  Device,
  Gender,
  OtpChallenge,
  Platform,
  RefreshToken,
  User,
  UserStatus,
} from '@prisma/client';
import type { AuditEntry } from '../../../common/contracts/admin';
import type { TypedOutboxEventInput } from '../../../common/contracts/events';
import type { Tx } from '../../../common/prisma/prisma.service';
import type { AdminFailureUpdate, AdminLockPolicy } from '../domain/admin-login';
import type { OtpPhoneHistoryRow } from '../domain/otp';
import type { UserSearchTerms } from '../domain/user-search';

/**
 * Persistence boundary of the identity module. Services talk to this abstract class; the
 * Prisma implementation (prisma-identity.store.ts) owns every query against the identity
 * tables, and an in-memory implementation (../testing/in-memory-identity.store.ts) lets unit and e2e tests run
 * the full flows without PostgreSQL. `run()` is the unit of work: everything inside it,
 * including outbox events and audit rows, commits or rolls back together.
 */

export interface UserCreateData {
  id: string;
  phone: string;
  memberCode: string;
  createdAt: Date;
}

export interface UserUpdateData {
  phone?: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: Date | null;
  gender?: Gender | null;
  city?: string | null;
  status?: UserStatus;
  profileCompletedAt?: Date | null;
  /** Replaces the list of profile fields already announced with user.profile_field_completed. */
  completedProfileFields?: string[];
  deletedAt?: Date | null;
}

export interface ChildCreateData {
  id: string;
  userId: string;
  birthMonth: number;
  birthYear: number;
  gender: Gender;
  createdAt: Date;
}

export interface ChildUpdateData {
  birthMonth?: number;
  birthYear?: number;
  gender?: Gender;
}

export interface DeviceCreateData {
  id: string;
  userId: string;
  platform: Platform;
  model: string | null;
  appVersion: string | null;
  fingerprint: string | null;
  pushToken: string | null;
  pushEnabled: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface DeviceUpdateData {
  model?: string | null;
  appVersion?: string | null;
  fingerprint?: string | null;
  pushToken?: string | null;
  pushEnabled?: boolean;
  lastSeenAt?: Date;
}

export interface PushTokenClearFilter {
  userId: string;
  deviceId?: string;
}

export interface ConsentCreateData {
  id: string;
  userId: string;
  purpose: ConsentPurpose;
  version: string;
  grantedAt: Date;
}

export interface OtpChallengeCreateData {
  id: string;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  maxAttempts: number;
  ip: string | null;
  deviceFingerprint: string | null;
  createdAt: Date;
}

export interface OtpChallengeCountFilter {
  phone?: string;
  ip?: string;
  /** Exclusive: challenges created strictly after this moment (a window of N seconds ending now). */
  since: Date;
}

export interface OtpRequestTimesFilter {
  /** Rate-limit key (IPv4 address or IPv6 /64), as stored in otp_challenges.ip. */
  ip: string;
  /** Exclusive lower bound, as in OtpChallengeCountFilter. */
  since: Date;
}

export interface OtpChallengeDeleteFilter {
  phone?: string;
  createdBefore?: Date;
}

export interface RefreshTokenCreateData {
  id: string;
  userId: string;
  deviceId: string | null;
  family: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface RefreshTokenRevokeFilter {
  userId?: string;
  family?: string;
  deviceId?: string;
  /** Keep this token (the one that performs the logout of other sessions). */
  exceptId?: string;
}

export interface DeletionRequestCreateData {
  id: string;
  userId: string;
  requestedAt: Date;
  executeAfter: Date;
  reason: string | null;
}

export interface DeletionRequestUpdateData {
  executedAt?: Date;
  cancelledAt?: Date;
}

export interface AdminCreateData {
  id: string;
  email: string;
  passwordHash: string;
  role: AdminRole;
  name: string | null;
  active: boolean;
  createdAt: Date;
}

export interface AdminUpdateData {
  email?: string;
  passwordHash?: string;
  totpSecret?: string | null;
  /** Last accepted TOTP step; reset with the secret (enable/disable). */
  totpLastStep?: number | null;
  role?: AdminRole;
  name?: string | null;
  active?: boolean;
  lastLoginAt?: Date;
  failedLoginCount?: number;
  lastFailedLoginAt?: Date | null;
  lockedUntil?: Date | null;
  /** jti of the outstanding TOTP login challenge (null clears it: single use). */
  loginChallengeId?: string | null;
  loginChallengeAttempts?: number;
}

/** Keyset cursor for admin user lists: `(createdAt desc, id desc)`. */
export interface UserCursor {
  createdAt: string;
  id: string;
}

export interface UserSearchFilter {
  terms: UserSearchTerms | null;
  status?: UserStatus;
  cursor?: UserCursor;
  /** The store returns up to `limit + 1` rows so the caller can detect the next page. */
  limit: number;
}

/** Thrown by writes that hit a unique constraint (Prisma P2002 or the in-memory equivalent). */
export class StoreConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly fields: readonly string[],
  ) {
    super(`${entity}: unique constraint violated on ${fields.join(', ') || 'unknown field'}`);
    this.name = 'StoreConflictError';
  }

  static is(error: unknown): error is StoreConflictError {
    return error instanceof StoreConflictError;
  }

  /** Matches `email`, `member_code`, `users_member_code_key` and similar spellings. */
  has(field: string): boolean {
    const needle = field.replace(/_/g, '').toLowerCase();
    return this.fields.some((item) => item.replace(/_/g, '').toLowerCase().includes(needle));
  }
}

export interface IdentityReads {
  findUserById(id: string): Promise<User | null>;
  findUsersByIds(ids: readonly string[]): Promise<User[]>;
  findUserByPhone(phone: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserByMemberCode(memberCode: string): Promise<User | null>;
  searchUsers(filter: UserSearchFilter): Promise<User[]>;

  /** Children of the member, oldest first (birth year, then month). */
  listChildren(userId: string): Promise<Child[]>;
  findChildById(id: string): Promise<Child | null>;

  findDeviceById(id: string): Promise<Device | null>;
  findDeviceByFingerprint(userId: string, fingerprint: string): Promise<Device | null>;
  listDevices(userId: string): Promise<Device[]>;
  listPushDevices(userId: string): Promise<Device[]>;

  listConsents(userId: string): Promise<Consent[]>;
  /**
   * Ids of active users whose latest `marketing` consent (by grantedAt, then id) is not revoked,
   * ascending, strictly after `afterUserId`; at most `limit` ids.
   */
  listMarketingAudience(afterUserId: string | null, limit: number): Promise<string[]>;

  /** Latest challenge for the phone regardless of state (requesting a new code voids older ones). */
  findLatestOtpChallenge(phone: string): Promise<OtpChallenge | null>;
  /** Without phone and ip: every challenge since `since` (global daily SMS budget). */
  countOtpChallenges(filter: OtpChallengeCountFilter): Promise<number>;
  /**
   * Challenges of the phone created after `since`, oldest first (request limits, cooldown and the
   * wrong-code lock). Bounded by the rate limits themselves (a few rows per day).
   */
  listOtpPhoneHistory(phone: string, since: Date): Promise<OtpPhoneHistoryRow[]>;
  /** Creation times of challenges from one IP key after `since`, oldest first (at most `limit`). */
  listOtpRequestTimes(filter: OtpRequestTimesFilter, limit: number): Promise<Date[]>;

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null>;
  /** Usable tokens: not rotated, not revoked, not expired at `now`. */
  listActiveSessions(userId: string, now: Date): Promise<RefreshToken[]>;
  listRefreshTokens(userId: string, limit: number): Promise<RefreshToken[]>;

  findDeletionRequestById(id: string): Promise<AccountDeletionRequest | null>;
  findPendingDeletionRequest(userId: string): Promise<AccountDeletionRequest | null>;
  listDeletionRequests(userId: string): Promise<AccountDeletionRequest[]>;
  listDueDeletionRequests(now: Date, limit: number): Promise<AccountDeletionRequest[]>;

  findAdminById(id: string): Promise<AdminUser | null>;
  findAdminByEmail(email: string): Promise<AdminUser | null>;
  listAdmins(): Promise<AdminUser[]>;
  countActiveOwners(): Promise<number>;
}

export interface IdentityWrites {
  createUser(data: UserCreateData): Promise<User>;
  updateUser(id: string, data: UserUpdateData): Promise<User>;
  /**
   * Row lock on the user (`SELECT ... FOR UPDATE`) until the unit of work ends; returns the fresh
   * row. Serialises the children limit and the once-per-field profile events.
   */
  lockUser(id: string): Promise<User | null>;

  createChild(data: ChildCreateData): Promise<Child>;
  updateChild(id: string, data: ChildUpdateData): Promise<Child>;
  deleteChild(id: string): Promise<void>;
  /** Account deletion: removes every child row of the member. */
  deleteChildren(userId: string): Promise<number>;

  createDevice(data: DeviceCreateData): Promise<Device>;
  updateDevice(id: string, data: DeviceUpdateData): Promise<Device>;
  /** Account deletion: drops push tokens, fingerprints and model names of every device. */
  anonymiseDevices(userId: string): Promise<number>;
  /**
   * A push token belongs to one installation: when it shows up on a device row, every other
   * row holding it (another member who logged out on the same phone) loses it.
   */
  detachPushToken(pushToken: string, exceptDeviceId: string): Promise<number>;
  /** Logout: the member's devices (or one of them) stop receiving push. */
  clearPushTokens(filter: PushTokenClearFilter): Promise<number>;

  createConsent(data: ConsentCreateData): Promise<Consent>;
  revokeConsent(id: string, revokedAt: Date): Promise<Consent>;

  /**
   * Transaction-scoped advisory locks (`pg_advisory_xact_lock`) on the phone and, when given, the
   * IP key, taken in that order: the count-then-insert of an OTP request is atomic per phone and
   * per IP network. Must run inside `run()`.
   */
  lockOtpRequest(phone: string, ipKey: string | null): Promise<void>;
  createOtpChallenge(data: OtpChallengeCreateData): Promise<OtpChallenge>;
  recordOtpAttempt(id: string, attempts: number): Promise<void>;
  /**
   * Atomic `attempts = attempts + 1` while the challenge is unconsumed and below `maxAttempts`.
   * Returns the new counter, or null when no attempt is left (parallel guesses cannot overrun the limit).
   */
  claimOtpAttempt(id: string, maxAttempts: number): Promise<number | null>;
  /** Atomic: true when this call consumed the challenge, false when it was already consumed. */
  consumeOtpChallenge(id: string, consumedAt: Date): Promise<boolean>;
  deleteOtpChallenges(filter: OtpChallengeDeleteFilter): Promise<number>;

  createRefreshToken(data: RefreshTokenCreateData): Promise<RefreshToken>;
  /** Atomic: marks the token revoked for rotation; false when another request already did. */
  claimRefreshToken(id: string, now: Date): Promise<boolean>;
  linkReplacedBy(id: string, successorId: string): Promise<void>;
  revokeRefreshTokens(filter: RefreshTokenRevokeFilter, now: Date): Promise<number>;
  /** Housekeeping: removes tokens expired or revoked before `before`. */
  deleteRefreshTokens(before: Date): Promise<number>;

  createDeletionRequest(data: DeletionRequestCreateData): Promise<AccountDeletionRequest>;
  updateDeletionRequest(
    id: string,
    data: DeletionRequestUpdateData,
  ): Promise<AccountDeletionRequest>;

  createAdmin(data: AdminCreateData): Promise<AdminUser>;
  updateAdmin(id: string, data: AdminUpdateData): Promise<AdminUser>;
  /**
   * TOTP replay protection: atomically records `step` (unix seconds / 30) as the last accepted
   * step when it is newer than the stored one. False when this or a later step was already used.
   */
  claimTotpStep(adminId: string, step: number): Promise<boolean>;
  /**
   * Counts one failed login under a row lock and applies the lockout policy
   * (domain/admin-login.ts registerAdminLoginFailure). Null when the admin does not exist.
   */
  recordAdminLoginFailure(
    adminId: string,
    now: Date,
    policy: AdminLockPolicy,
  ): Promise<AdminFailureUpdate | null>;
  /**
   * Atomic `login_challenge_attempts + 1` while `login_challenge_id = challengeId` and attempts are
   * below `maxAttempts`. Returns the new count, or null for an unknown, superseded, used or
   * exhausted challenge.
   */
  claimLoginChallengeAttempt(
    adminId: string,
    challengeId: string,
    maxAttempts: number,
  ): Promise<number | null>;

  /** Outbox event in the same transaction (brief section 3). */
  publish(event: TypedOutboxEventInput): Promise<void>;
  /** Audit row in the same transaction (ADMIN_AUDIT_PORT). */
  audit(entry: AuditEntry): Promise<void>;
}

export interface IdentityUow extends IdentityReads, IdentityWrites {}

/**
 * Injection token and read facade. Implementations provide `run()` and `bind()`; the read
 * methods below delegate to the root (non-transactional) view.
 */
export abstract class IdentityStore implements IdentityReads {
  abstract run<T>(fn: (uow: IdentityUow) => Promise<T>): Promise<T>;
  /** Read view joined to a caller's transaction (ports from other modules pass their `tx`). */
  abstract bind(tx?: Tx): IdentityReads;

  findUserById(id: string): Promise<User | null> {
    return this.bind().findUserById(id);
  }
  findUsersByIds(ids: readonly string[]): Promise<User[]> {
    return this.bind().findUsersByIds(ids);
  }
  findUserByPhone(phone: string): Promise<User | null> {
    return this.bind().findUserByPhone(phone);
  }
  findUserByEmail(email: string): Promise<User | null> {
    return this.bind().findUserByEmail(email);
  }
  findUserByMemberCode(memberCode: string): Promise<User | null> {
    return this.bind().findUserByMemberCode(memberCode);
  }
  searchUsers(filter: UserSearchFilter): Promise<User[]> {
    return this.bind().searchUsers(filter);
  }
  listChildren(userId: string): Promise<Child[]> {
    return this.bind().listChildren(userId);
  }
  findChildById(id: string): Promise<Child | null> {
    return this.bind().findChildById(id);
  }
  findDeviceById(id: string): Promise<Device | null> {
    return this.bind().findDeviceById(id);
  }
  findDeviceByFingerprint(userId: string, fingerprint: string): Promise<Device | null> {
    return this.bind().findDeviceByFingerprint(userId, fingerprint);
  }
  listDevices(userId: string): Promise<Device[]> {
    return this.bind().listDevices(userId);
  }
  listPushDevices(userId: string): Promise<Device[]> {
    return this.bind().listPushDevices(userId);
  }
  listConsents(userId: string): Promise<Consent[]> {
    return this.bind().listConsents(userId);
  }
  listMarketingAudience(afterUserId: string | null, limit: number): Promise<string[]> {
    return this.bind().listMarketingAudience(afterUserId, limit);
  }
  findLatestOtpChallenge(phone: string): Promise<OtpChallenge | null> {
    return this.bind().findLatestOtpChallenge(phone);
  }
  countOtpChallenges(filter: OtpChallengeCountFilter): Promise<number> {
    return this.bind().countOtpChallenges(filter);
  }
  listOtpPhoneHistory(phone: string, since: Date): Promise<OtpPhoneHistoryRow[]> {
    return this.bind().listOtpPhoneHistory(phone, since);
  }
  listOtpRequestTimes(filter: OtpRequestTimesFilter, limit: number): Promise<Date[]> {
    return this.bind().listOtpRequestTimes(filter, limit);
  }
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.bind().findRefreshTokenByHash(tokenHash);
  }
  listActiveSessions(userId: string, now: Date): Promise<RefreshToken[]> {
    return this.bind().listActiveSessions(userId, now);
  }
  listRefreshTokens(userId: string, limit: number): Promise<RefreshToken[]> {
    return this.bind().listRefreshTokens(userId, limit);
  }
  findDeletionRequestById(id: string): Promise<AccountDeletionRequest | null> {
    return this.bind().findDeletionRequestById(id);
  }
  findPendingDeletionRequest(userId: string): Promise<AccountDeletionRequest | null> {
    return this.bind().findPendingDeletionRequest(userId);
  }
  listDeletionRequests(userId: string): Promise<AccountDeletionRequest[]> {
    return this.bind().listDeletionRequests(userId);
  }
  listDueDeletionRequests(now: Date, limit: number): Promise<AccountDeletionRequest[]> {
    return this.bind().listDueDeletionRequests(now, limit);
  }
  findAdminById(id: string): Promise<AdminUser | null> {
    return this.bind().findAdminById(id);
  }
  findAdminByEmail(email: string): Promise<AdminUser | null> {
    return this.bind().findAdminByEmail(email);
  }
  listAdmins(): Promise<AdminUser[]> {
    return this.bind().listAdmins();
  }
  countActiveOwners(): Promise<number> {
    return this.bind().countActiveOwners();
  }
}
