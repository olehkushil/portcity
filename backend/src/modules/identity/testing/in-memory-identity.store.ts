import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AccountDeletionRequest,
  AdminUser,
  Child,
  Consent,
  Device,
  OtpChallenge,
  RefreshToken,
  User,
} from '@prisma/client';
import type { AuditEntry } from '../../../common/contracts/admin';
import type { TypedOutboxEventInput } from '../../../common/contracts/events';
import type { Tx } from '../../../common/prisma/prisma.service';
import {
  type AdminFailureUpdate,
  type AdminLockPolicy,
  registerAdminLoginFailure,
} from '../domain/admin-login';
import type { OtpPhoneHistoryRow } from '../domain/otp';
import {
  type AdminCreateData,
  type AdminUpdateData,
  type ChildCreateData,
  type ChildUpdateData,
  type ConsentCreateData,
  type DeletionRequestCreateData,
  type DeletionRequestUpdateData,
  type DeviceCreateData,
  type DeviceUpdateData,
  type IdentityReads,
  IdentityStore,
  type IdentityUow,
  type OtpChallengeCountFilter,
  type OtpChallengeCreateData,
  type OtpChallengeDeleteFilter,
  type OtpRequestTimesFilter,
  type PushTokenClearFilter,
  type RefreshTokenCreateData,
  type RefreshTokenRevokeFilter,
  StoreConflictError,
  type UserCreateData,
  type UserSearchFilter,
  type UserUpdateData,
} from '../services/identity.store';

/** Everything the store holds; cloned for rollback when a unit of work fails. */
export interface IdentityState {
  users: Map<string, User>;
  children: Map<string, Child>;
  devices: Map<string, Device>;
  consents: Map<string, Consent>;
  otpChallenges: Map<string, OtpChallenge>;
  refreshTokens: Map<string, RefreshToken>;
  deletionRequests: Map<string, AccountDeletionRequest>;
  admins: Map<string, AdminUser>;
  events: TypedOutboxEventInput[];
  audits: AuditEntry[];
}

function emptyState(): IdentityState {
  return {
    users: new Map(),
    children: new Map(),
    devices: new Map(),
    consents: new Map(),
    otpChallenges: new Map(),
    refreshTokens: new Map(),
    deletionRequests: new Map(),
    admins: new Map(),
    events: [],
    audits: [],
  };
}

const copy = <T>(value: T): T => structuredClone(value);
const time = (date: Date): number => date.getTime();

function byCreatedDesc<T extends { createdAt: Date; id: string }>(a: T, b: T): number {
  return time(b.createdAt) - time(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function byCreatedAsc<T extends { createdAt: Date; id: string }>(a: T, b: T): number {
  return -byCreatedDesc(a, b);
}

function requireRow<T>(map: Map<string, T>, id: string, entity: string): T {
  const row = map.get(id);
  if (!row) {
    // Prisma throws P2025 for update() on a missing row; tests only need "it failed".
    throw new Error(`${entity} ${id} not found`);
  }
  return row;
}

function includesInsensitive(value: string | null, needle: string): boolean {
  return value !== null && value.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Behaves like PrismaIdentityStore for the subset of semantics the services rely on:
 * unique constraints (phone, email, member code, token hash, admin email) raise
 * StoreConflictError, `run()` is atomic (state is restored when the callback throws), outbox
 * events and audit rows are recorded only when the unit of work commits, rows are returned as
 * copies so callers cannot mutate the store by accident.
 */
export class InMemoryIdentityStore extends IdentityStore {
  state: IdentityState = emptyState();
  private readonly root: InMemoryUow;
  private readonly runContext = new AsyncLocalStorage<boolean>();
  private runTail: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date()) {
    super();
    this.root = new InMemoryUow(this, false);
  }

  get events(): TypedOutboxEventInput[] {
    return this.state.events;
  }

  get audits(): AuditEntry[] {
    return this.state.audits;
  }

  /** Event types published so far, in order. */
  eventTypes(): string[] {
    return this.state.events.map((event) => event.type);
  }

  currentTime(): Date {
    return this.now();
  }

  /**
   * Units of work run one at a time (like SERIALIZABLE transactions), which also stands in for
   * the row locks and advisory locks of the Prisma store (`lockUser`, `lockOtpRequest`). A run
   * started from inside another run's callback joins it instead of waiting for it.
   */
  async run<T>(fn: (uow: IdentityUow) => Promise<T>): Promise<T> {
    if (this.runContext.getStore() === true) {
      return fn(new InMemoryUow(this, true));
    }
    const previous = this.runTail;
    let release: () => void = () => undefined;
    this.runTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = this.snapshot();
    try {
      return await this.runContext.run(true, () => fn(new InMemoryUow(this, true)));
    } catch (error) {
      this.state = snapshot;
      throw error;
    } finally {
      release();
    }
  }

  bind(_tx?: Tx): IdentityReads {
    return this.root;
  }

  // -- seeding helpers for tests ------------------------------------------------------------

  seedUser(partial: Partial<User> & Pick<User, 'id' | 'phone' | 'memberCode'>): User {
    const createdAt = partial.createdAt ?? this.now();
    const user: User = {
      email: null,
      firstName: null,
      lastName: null,
      birthDate: null,
      gender: null,
      city: null,
      status: 'active',
      profileCompletedAt: null,
      completedProfileFields: [],
      deletedAt: null,
      updatedAt: createdAt,
      ...partial,
      createdAt,
    };
    this.state.users.set(user.id, copy(user));
    return copy(user);
  }

  seedAdmin(
    partial: Partial<AdminUser> & Pick<AdminUser, 'id' | 'email' | 'passwordHash'>,
  ): AdminUser {
    const createdAt = partial.createdAt ?? this.now();
    const admin: AdminUser = {
      totpSecret: null,
      totpLastStep: null,
      role: 'owner',
      name: null,
      active: true,
      lastLoginAt: null,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      loginChallengeId: null,
      loginChallengeAttempts: 0,
      updatedAt: createdAt,
      ...partial,
      createdAt,
    };
    this.state.admins.set(admin.id, copy(admin));
    return copy(admin);
  }

  seedDevice(partial: Partial<Device> & Pick<Device, 'id' | 'userId'>): Device {
    const createdAt = partial.createdAt ?? this.now();
    const device: Device = {
      platform: 'android',
      model: null,
      appVersion: null,
      fingerprint: null,
      pushToken: null,
      pushEnabled: false,
      lastSeenAt: null,
      ...partial,
      createdAt,
    };
    this.state.devices.set(device.id, copy(device));
    return copy(device);
  }

  private snapshot(): IdentityState {
    return {
      users: copy(this.state.users),
      children: copy(this.state.children),
      devices: copy(this.state.devices),
      consents: copy(this.state.consents),
      otpChallenges: copy(this.state.otpChallenges),
      refreshTokens: copy(this.state.refreshTokens),
      deletionRequests: copy(this.state.deletionRequests),
      admins: copy(this.state.admins),
      events: [...this.state.events],
      audits: [...this.state.audits],
    };
  }
}

class InMemoryUow implements IdentityUow {
  constructor(
    private readonly store: InMemoryIdentityStore,
    private readonly inTransaction: boolean,
  ) {}

  private get s(): IdentityState {
    return this.store.state;
  }

  // -- users ------------------------------------------------------------------------------

  async findUserById(id: string): Promise<User | null> {
    const user = this.s.users.get(id);
    return user ? copy(user) : null;
  }

  async findUsersByIds(ids: readonly string[]): Promise<User[]> {
    return ids.flatMap((id) => {
      const user = this.s.users.get(id);
      return user ? [copy(user)] : [];
    });
  }

  async findUserByPhone(phone: string): Promise<User | null> {
    const user = [...this.s.users.values()].find((row) => row.phone === phone);
    return user ? copy(user) : null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const user = [...this.s.users.values()].find((row) => row.email === email);
    return user ? copy(user) : null;
  }

  async findUserByMemberCode(memberCode: string): Promise<User | null> {
    const user = [...this.s.users.values()].find((row) => row.memberCode === memberCode);
    return user ? copy(user) : null;
  }

  async searchUsers(filter: UserSearchFilter): Promise<User[]> {
    const terms = filter.terms;
    const rows = [...this.s.users.values()].filter((user) => {
      if (filter.status && user.status !== filter.status) {
        return false;
      }
      if (terms) {
        const matches: boolean[] = [];
        if (terms.email) {
          matches.push(includesInsensitive(user.email, terms.email));
        }
        if (terms.phoneExact) {
          matches.push(user.phone === terms.phoneExact);
        }
        if (terms.memberCode) {
          matches.push(user.memberCode === terms.memberCode);
        }
        if (terms.digitFragment) {
          matches.push(
            user.phone.includes(terms.digitFragment) ||
              user.memberCode.includes(terms.digitFragment),
          );
        }
        if (terms.name) {
          matches.push(
            includesInsensitive(user.firstName, terms.name) ||
              includesInsensitive(user.lastName, terms.name),
          );
        }
        if (matches.length > 0 && !matches.some(Boolean)) {
          return false;
        }
      }
      if (filter.cursor) {
        const createdAt = new Date(filter.cursor.createdAt).getTime();
        const rowTime = time(user.createdAt);
        if (!(rowTime < createdAt || (rowTime === createdAt && user.id < filter.cursor.id))) {
          return false;
        }
      }
      return true;
    });
    return rows
      .sort(byCreatedDesc)
      .slice(0, filter.limit + 1)
      .map(copy);
  }

  async createUser(data: UserCreateData): Promise<User> {
    for (const row of this.s.users.values()) {
      if (row.phone === data.phone) {
        throw new StoreConflictError('user', ['phone']);
      }
      if (row.memberCode === data.memberCode) {
        throw new StoreConflictError('user', ['member_code']);
      }
    }
    const user: User = {
      id: data.id,
      phone: data.phone,
      email: null,
      firstName: null,
      lastName: null,
      birthDate: null,
      gender: null,
      city: null,
      status: 'active',
      memberCode: data.memberCode,
      profileCompletedAt: null,
      completedProfileFields: [],
      createdAt: data.createdAt,
      updatedAt: data.createdAt,
      deletedAt: null,
    };
    this.s.users.set(user.id, user);
    return copy(user);
  }

  async updateUser(id: string, data: UserUpdateData): Promise<User> {
    const user = requireRow(this.s.users, id, 'user');
    for (const row of this.s.users.values()) {
      if (row.id === id) {
        continue;
      }
      if (data.phone !== undefined && row.phone === data.phone) {
        throw new StoreConflictError('user', ['phone']);
      }
      if (data.email !== undefined && data.email !== null && row.email === data.email) {
        throw new StoreConflictError('user', ['email']);
      }
    }
    const updated: User = { ...user, ...stripUndefined(data), updatedAt: this.store.currentTime() };
    this.s.users.set(id, updated);
    return copy(updated);
  }

  async lockUser(id: string): Promise<User | null> {
    // run() is serialised, which is what the Prisma store's row lock guarantees.
    const user = this.s.users.get(id);
    return user ? copy(user) : null;
  }

  // -- children ---------------------------------------------------------------------------

  async listChildren(userId: string): Promise<Child[]> {
    return [...this.s.children.values()]
      .filter((row) => row.userId === userId)
      .sort(
        (a, b) =>
          a.birthYear - b.birthYear ||
          a.birthMonth - b.birthMonth ||
          time(a.createdAt) - time(b.createdAt) ||
          (a.id < b.id ? -1 : 1),
      )
      .map(copy);
  }

  async findChildById(id: string): Promise<Child | null> {
    const child = this.s.children.get(id);
    return child ? copy(child) : null;
  }

  async createChild(data: ChildCreateData): Promise<Child> {
    requireRow(this.s.users, data.userId, 'user');
    const child: Child = { ...data, updatedAt: data.createdAt };
    this.s.children.set(child.id, child);
    return copy(child);
  }

  async updateChild(id: string, data: ChildUpdateData): Promise<Child> {
    const child = requireRow(this.s.children, id, 'child');
    const updated: Child = {
      ...child,
      ...stripUndefined(data),
      updatedAt: this.store.currentTime(),
    };
    this.s.children.set(id, updated);
    return copy(updated);
  }

  async deleteChild(id: string): Promise<void> {
    requireRow(this.s.children, id, 'child');
    this.s.children.delete(id);
  }

  async deleteChildren(userId: string): Promise<number> {
    let count = 0;
    for (const [id, child] of this.s.children) {
      if (child.userId === userId) {
        this.s.children.delete(id);
        count += 1;
      }
    }
    return count;
  }

  // -- devices ----------------------------------------------------------------------------

  async findDeviceById(id: string): Promise<Device | null> {
    const device = this.s.devices.get(id);
    return device ? copy(device) : null;
  }

  async findDeviceByFingerprint(userId: string, fingerprint: string): Promise<Device | null> {
    const device = [...this.s.devices.values()]
      .filter((row) => row.userId === userId && row.fingerprint === fingerprint)
      .sort(byCreatedDesc)[0];
    return device ? copy(device) : null;
  }

  async listDevices(userId: string): Promise<Device[]> {
    return [...this.s.devices.values()]
      .filter((row) => row.userId === userId)
      .sort(byCreatedAsc)
      .map(copy);
  }

  async listPushDevices(userId: string): Promise<Device[]> {
    return [...this.s.devices.values()]
      .filter((row) => row.userId === userId && row.pushEnabled && row.pushToken !== null)
      .sort(byCreatedAsc)
      .map(copy);
  }

  async createDevice(data: DeviceCreateData): Promise<Device> {
    const device: Device = { ...data };
    this.s.devices.set(device.id, device);
    return copy(device);
  }

  async updateDevice(id: string, data: DeviceUpdateData): Promise<Device> {
    const device = requireRow(this.s.devices, id, 'device');
    const updated: Device = { ...device, ...stripUndefined(data) };
    this.s.devices.set(id, updated);
    return copy(updated);
  }

  async anonymiseDevices(userId: string): Promise<number> {
    let count = 0;
    for (const device of this.s.devices.values()) {
      if (device.userId === userId) {
        Object.assign(device, {
          pushToken: null,
          pushEnabled: false,
          fingerprint: null,
          model: null,
          appVersion: null,
        });
        count += 1;
      }
    }
    return count;
  }

  async detachPushToken(pushToken: string, exceptDeviceId: string): Promise<number> {
    let count = 0;
    for (const device of this.s.devices.values()) {
      if (device.pushToken === pushToken && device.id !== exceptDeviceId) {
        device.pushToken = null;
        device.pushEnabled = false;
        count += 1;
      }
    }
    return count;
  }

  async clearPushTokens(filter: PushTokenClearFilter): Promise<number> {
    let count = 0;
    for (const device of this.s.devices.values()) {
      if (
        device.userId === filter.userId &&
        (filter.deviceId === undefined || device.id === filter.deviceId)
      ) {
        device.pushToken = null;
        device.pushEnabled = false;
        count += 1;
      }
    }
    return count;
  }

  // -- consents ---------------------------------------------------------------------------

  async listConsents(userId: string): Promise<Consent[]> {
    return [...this.s.consents.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => time(a.grantedAt) - time(b.grantedAt) || (a.id < b.id ? -1 : 1))
      .map(copy);
  }

  async listMarketingAudience(afterUserId: string | null, limit: number): Promise<string[]> {
    const latest = new Map<string, Consent>();
    for (const row of this.s.consents.values()) {
      if (row.purpose !== 'marketing') {
        continue;
      }
      const current = latest.get(row.userId);
      if (
        !current ||
        time(row.grantedAt) > time(current.grantedAt) ||
        (time(row.grantedAt) === time(current.grantedAt) && row.id > current.id)
      ) {
        latest.set(row.userId, row);
      }
    }
    return [...this.s.users.values()]
      .filter((user) => user.status === 'active')
      .filter((user) => afterUserId === null || user.id > afterUserId)
      .filter((user) => {
        const consent = latest.get(user.id);
        return consent !== undefined && consent.revokedAt === null;
      })
      .map((user) => user.id)
      .sort()
      .slice(0, limit);
  }

  async createConsent(data: ConsentCreateData): Promise<Consent> {
    const consent: Consent = { ...data, revokedAt: null };
    this.s.consents.set(consent.id, consent);
    return copy(consent);
  }

  async revokeConsent(id: string, revokedAt: Date): Promise<Consent> {
    const consent = requireRow(this.s.consents, id, 'consent');
    consent.revokedAt = revokedAt;
    return copy(consent);
  }

  // -- OTP challenges ---------------------------------------------------------------------

  async findLatestOtpChallenge(phone: string): Promise<OtpChallenge | null> {
    const challenge = [...this.s.otpChallenges.values()]
      .filter((row) => row.phone === phone)
      .sort(byCreatedDesc)[0];
    return challenge ? copy(challenge) : null;
  }

  async countOtpChallenges(filter: OtpChallengeCountFilter): Promise<number> {
    return [...this.s.otpChallenges.values()].filter(
      (row) =>
        (filter.phone === undefined || row.phone === filter.phone) &&
        (filter.ip === undefined || row.ip === filter.ip) &&
        time(row.createdAt) > time(filter.since),
    ).length;
  }

  async listOtpPhoneHistory(phone: string, since: Date): Promise<OtpPhoneHistoryRow[]> {
    return [...this.s.otpChallenges.values()]
      .filter((row) => row.phone === phone && time(row.createdAt) > time(since))
      .sort(byCreatedAsc)
      .map((row) => ({
        createdAt: new Date(row.createdAt),
        attempts: row.attempts,
        consumedAt: row.consumedAt ? new Date(row.consumedAt) : null,
      }));
  }

  async listOtpRequestTimes(filter: OtpRequestTimesFilter, limit: number): Promise<Date[]> {
    return [...this.s.otpChallenges.values()]
      .filter((row) => row.ip === filter.ip && time(row.createdAt) > time(filter.since))
      .sort(byCreatedAsc)
      .slice(0, limit)
      .map((row) => new Date(row.createdAt));
  }

  async lockOtpRequest(_phone: string, _ipKey: string | null): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('IdentityStore.lockOtpRequest() must be called inside run()');
    }
    // run() is serialised, which is what the advisory locks guarantee in PostgreSQL.
  }

  async createOtpChallenge(data: OtpChallengeCreateData): Promise<OtpChallenge> {
    const challenge: OtpChallenge = { ...data, attempts: 0, consumedAt: null };
    this.s.otpChallenges.set(challenge.id, challenge);
    return copy(challenge);
  }

  async recordOtpAttempt(id: string, attempts: number): Promise<void> {
    requireRow(this.s.otpChallenges, id, 'otp_challenge').attempts = attempts;
  }

  async claimOtpAttempt(id: string, maxAttempts: number): Promise<number | null> {
    const challenge = this.s.otpChallenges.get(id);
    if (!challenge || challenge.consumedAt !== null || challenge.attempts >= maxAttempts) {
      return null;
    }
    challenge.attempts += 1;
    return challenge.attempts;
  }

  async consumeOtpChallenge(id: string, consumedAt: Date): Promise<boolean> {
    const challenge = this.s.otpChallenges.get(id);
    if (!challenge || challenge.consumedAt !== null) {
      return false;
    }
    challenge.consumedAt = consumedAt;
    return true;
  }

  async deleteOtpChallenges(filter: OtpChallengeDeleteFilter): Promise<number> {
    let count = 0;
    for (const [id, row] of this.s.otpChallenges) {
      if (
        (filter.phone === undefined || row.phone === filter.phone) &&
        (filter.createdBefore === undefined || time(row.createdAt) < time(filter.createdBefore))
      ) {
        this.s.otpChallenges.delete(id);
        count += 1;
      }
    }
    return count;
  }

  // -- refresh tokens ---------------------------------------------------------------------

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
    const token = [...this.s.refreshTokens.values()].find((row) => row.tokenHash === tokenHash);
    return token ? copy(token) : null;
  }

  async listActiveSessions(userId: string, now: Date): Promise<RefreshToken[]> {
    return [...this.s.refreshTokens.values()]
      .filter(
        (row) =>
          row.userId === userId &&
          row.revokedAt === null &&
          row.replacedById === null &&
          time(row.expiresAt) > time(now),
      )
      .sort(byCreatedDesc)
      .map(copy);
  }

  async listRefreshTokens(userId: string, limit: number): Promise<RefreshToken[]> {
    return [...this.s.refreshTokens.values()]
      .filter((row) => row.userId === userId)
      .sort(byCreatedDesc)
      .slice(0, limit)
      .map(copy);
  }

  async createRefreshToken(data: RefreshTokenCreateData): Promise<RefreshToken> {
    for (const row of this.s.refreshTokens.values()) {
      if (row.tokenHash === data.tokenHash) {
        throw new StoreConflictError('refresh_token', ['token_hash']);
      }
    }
    const token: RefreshToken = { ...data, revokedAt: null, replacedById: null };
    this.s.refreshTokens.set(token.id, token);
    return copy(token);
  }

  async claimRefreshToken(id: string, now: Date): Promise<boolean> {
    const token = this.s.refreshTokens.get(id);
    if (!token || token.revokedAt !== null || token.replacedById !== null) {
      return false;
    }
    token.revokedAt = now;
    return true;
  }

  async linkReplacedBy(id: string, successorId: string): Promise<void> {
    requireRow(this.s.refreshTokens, id, 'refresh_token').replacedById = successorId;
  }

  async revokeRefreshTokens(filter: RefreshTokenRevokeFilter, now: Date): Promise<number> {
    let count = 0;
    for (const token of this.s.refreshTokens.values()) {
      if (
        token.revokedAt === null &&
        (filter.userId === undefined || token.userId === filter.userId) &&
        (filter.family === undefined || token.family === filter.family) &&
        (filter.deviceId === undefined || token.deviceId === filter.deviceId) &&
        (filter.exceptId === undefined || token.id !== filter.exceptId)
      ) {
        token.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  async deleteRefreshTokens(before: Date): Promise<number> {
    let count = 0;
    for (const [id, token] of this.s.refreshTokens) {
      if (
        time(token.expiresAt) < time(before) ||
        (token.revokedAt !== null && time(token.revokedAt) < time(before))
      ) {
        this.s.refreshTokens.delete(id);
        count += 1;
      }
    }
    return count;
  }

  // -- deletion requests ------------------------------------------------------------------

  async findDeletionRequestById(id: string): Promise<AccountDeletionRequest | null> {
    const request = this.s.deletionRequests.get(id);
    return request ? copy(request) : null;
  }

  async findPendingDeletionRequest(userId: string): Promise<AccountDeletionRequest | null> {
    const request = [...this.s.deletionRequests.values()]
      .filter((row) => row.userId === userId && row.executedAt === null && row.cancelledAt === null)
      .sort((a, b) => time(b.requestedAt) - time(a.requestedAt))[0];
    return request ? copy(request) : null;
  }

  async listDeletionRequests(userId: string): Promise<AccountDeletionRequest[]> {
    return [...this.s.deletionRequests.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => time(b.requestedAt) - time(a.requestedAt))
      .map(copy);
  }

  async listDueDeletionRequests(now: Date, limit: number): Promise<AccountDeletionRequest[]> {
    return [...this.s.deletionRequests.values()]
      .filter(
        (row) =>
          row.executedAt === null &&
          row.cancelledAt === null &&
          time(row.executeAfter) <= time(now),
      )
      .sort((a, b) => time(a.executeAfter) - time(b.executeAfter))
      .slice(0, limit)
      .map(copy);
  }

  async createDeletionRequest(data: DeletionRequestCreateData): Promise<AccountDeletionRequest> {
    const request: AccountDeletionRequest = { ...data, executedAt: null, cancelledAt: null };
    this.s.deletionRequests.set(request.id, request);
    return copy(request);
  }

  async updateDeletionRequest(
    id: string,
    data: DeletionRequestUpdateData,
  ): Promise<AccountDeletionRequest> {
    const request = requireRow(this.s.deletionRequests, id, 'account_deletion_request');
    Object.assign(request, stripUndefined(data));
    return copy(request);
  }

  // -- admin users ------------------------------------------------------------------------

  async findAdminById(id: string): Promise<AdminUser | null> {
    const admin = this.s.admins.get(id);
    return admin ? copy(admin) : null;
  }

  async findAdminByEmail(email: string): Promise<AdminUser | null> {
    const admin = [...this.s.admins.values()].find((row) => row.email === email);
    return admin ? copy(admin) : null;
  }

  async listAdmins(): Promise<AdminUser[]> {
    return [...this.s.admins.values()].sort(byCreatedAsc).map(copy);
  }

  async countActiveOwners(): Promise<number> {
    return [...this.s.admins.values()].filter((row) => row.role === 'owner' && row.active).length;
  }

  async createAdmin(data: AdminCreateData): Promise<AdminUser> {
    if ([...this.s.admins.values()].some((row) => row.email === data.email)) {
      throw new StoreConflictError('admin_user', ['email']);
    }
    const admin: AdminUser = {
      ...data,
      totpSecret: null,
      totpLastStep: null,
      lastLoginAt: null,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      loginChallengeId: null,
      loginChallengeAttempts: 0,
      updatedAt: data.createdAt,
    };
    this.s.admins.set(admin.id, admin);
    return copy(admin);
  }

  async updateAdmin(id: string, data: AdminUpdateData): Promise<AdminUser> {
    const admin = requireRow(this.s.admins, id, 'admin_user');
    if (
      data.email !== undefined &&
      [...this.s.admins.values()].some((row) => row.id !== id && row.email === data.email)
    ) {
      throw new StoreConflictError('admin_user', ['email']);
    }
    const updated: AdminUser = {
      ...admin,
      ...stripUndefined(data),
      updatedAt: this.store.currentTime(),
    };
    this.s.admins.set(id, updated);
    return copy(updated);
  }

  async claimTotpStep(adminId: string, step: number): Promise<boolean> {
    const admin = this.s.admins.get(adminId);
    if (!admin || (admin.totpLastStep !== null && admin.totpLastStep >= step)) {
      return false;
    }
    admin.totpLastStep = step;
    return true;
  }

  async recordAdminLoginFailure(
    adminId: string,
    now: Date,
    policy: AdminLockPolicy,
  ): Promise<AdminFailureUpdate | null> {
    const admin = this.s.admins.get(adminId);
    if (!admin) {
      return null;
    }
    const next = registerAdminLoginFailure(admin, now, policy);
    admin.failedLoginCount = next.failedLoginCount;
    admin.lastFailedLoginAt = next.lastFailedLoginAt;
    admin.lockedUntil = next.lockedUntil;
    return copy(next);
  }

  async claimLoginChallengeAttempt(
    adminId: string,
    challengeId: string,
    maxAttempts: number,
  ): Promise<number | null> {
    const admin = this.s.admins.get(adminId);
    if (
      !admin ||
      admin.loginChallengeId !== challengeId ||
      admin.loginChallengeAttempts >= maxAttempts
    ) {
      return null;
    }
    admin.loginChallengeAttempts += 1;
    return admin.loginChallengeAttempts;
  }

  // -- cross-cutting ----------------------------------------------------------------------

  async publish(event: TypedOutboxEventInput): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('IdentityStore.publish() must be called inside run()');
    }
    this.s.events.push(copy(event));
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.s.audits.push(copy(entry));
  }
}

function stripUndefined<T extends object>(data: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
