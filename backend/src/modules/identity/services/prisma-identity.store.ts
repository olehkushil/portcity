import { Inject, Injectable } from '@nestjs/common';
import {
  type AccountDeletionRequest,
  type AdminUser,
  type Child,
  type Consent,
  type Device,
  type OtpChallenge,
  Prisma,
  type RefreshToken,
  type User,
} from '@prisma/client';
import {
  ADMIN_AUDIT_PORT,
  type AdminAuditPort,
  type AuditEntry,
} from '../../../common/contracts/admin';
import type { TypedOutboxEventInput } from '../../../common/contracts/events';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { type DbClient, PrismaService, type Tx } from '../../../common/prisma/prisma.service';
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
} from './identity.store';

function conflictFields(error: Prisma.PrismaClientKnownRequestError): string[] {
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) {
    return target.map((item) => String(item));
  }
  return typeof target === 'string' ? [target] : [];
}

async function translateConflict<T>(entity: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StoreConflictError(entity, conflictFields(error));
    }
    throw error;
  }
}

/** One unit of work bound to either the root client or an open transaction. */
class PrismaIdentityUow implements IdentityUow {
  constructor(
    private readonly db: DbClient,
    private readonly tx: Tx | undefined,
    private readonly outbox: OutboxService,
    private readonly auditPort: AdminAuditPort,
  ) {}

  // -- users ------------------------------------------------------------------------------

  findUserById(id: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id } });
  }

  async findUsersByIds(ids: readonly string[]): Promise<User[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.db.user.findMany({ where: { id: { in: [...ids] } } });
  }

  findUserByPhone(phone: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { phone } });
  }

  findUserByEmail(email: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { email } });
  }

  findUserByMemberCode(memberCode: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { memberCode } });
  }

  searchUsers(filter: UserSearchFilter): Promise<User[]> {
    const and: Prisma.UserWhereInput[] = [];
    if (filter.status) {
      and.push({ status: filter.status });
    }
    const terms = filter.terms;
    if (terms) {
      const or: Prisma.UserWhereInput[] = [];
      if (terms.email) {
        or.push({ email: { contains: terms.email, mode: 'insensitive' } });
      }
      if (terms.phoneExact) {
        or.push({ phone: terms.phoneExact });
      }
      if (terms.memberCode) {
        or.push({ memberCode: terms.memberCode });
      }
      if (terms.digitFragment) {
        or.push({ phone: { contains: terms.digitFragment } });
        or.push({ memberCode: { contains: terms.digitFragment } });
      }
      if (terms.name) {
        or.push({ firstName: { contains: terms.name, mode: 'insensitive' } });
        or.push({ lastName: { contains: terms.name, mode: 'insensitive' } });
      }
      if (or.length > 0) {
        and.push({ OR: or });
      }
    }
    if (filter.cursor) {
      const createdAt = new Date(filter.cursor.createdAt);
      and.push({
        OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: filter.cursor.id } }],
      });
    }
    return this.db.user.findMany({
      where: and.length > 0 ? { AND: and } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
  }

  createUser(data: UserCreateData): Promise<User> {
    return translateConflict('user', () =>
      this.db.user.create({
        data: {
          id: data.id,
          phone: data.phone,
          memberCode: data.memberCode,
          status: 'active',
          createdAt: data.createdAt,
        },
      }),
    );
  }

  updateUser(id: string, data: UserUpdateData): Promise<User> {
    return translateConflict('user', () => this.db.user.update({ where: { id }, data }));
  }

  async lockUser(id: string): Promise<User | null> {
    this.requireTx('lockUser');
    await this.db.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    return this.db.user.findUnique({ where: { id } });
  }

  // -- children ---------------------------------------------------------------------------

  listChildren(userId: string): Promise<Child[]> {
    return this.db.child.findMany({
      where: { userId },
      orderBy: [{ birthYear: 'asc' }, { birthMonth: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  findChildById(id: string): Promise<Child | null> {
    return this.db.child.findUnique({ where: { id } });
  }

  createChild(data: ChildCreateData): Promise<Child> {
    return this.db.child.create({ data });
  }

  updateChild(id: string, data: ChildUpdateData): Promise<Child> {
    return this.db.child.update({ where: { id }, data });
  }

  async deleteChild(id: string): Promise<void> {
    await this.db.child.delete({ where: { id } });
  }

  async deleteChildren(userId: string): Promise<number> {
    const result = await this.db.child.deleteMany({ where: { userId } });
    return result.count;
  }

  // -- devices ----------------------------------------------------------------------------

  findDeviceById(id: string): Promise<Device | null> {
    return this.db.device.findUnique({ where: { id } });
  }

  findDeviceByFingerprint(userId: string, fingerprint: string): Promise<Device | null> {
    return this.db.device.findFirst({
      where: { userId, fingerprint },
      orderBy: { createdAt: 'desc' },
    });
  }

  listDevices(userId: string): Promise<Device[]> {
    return this.db.device.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  listPushDevices(userId: string): Promise<Device[]> {
    return this.db.device.findMany({
      where: { userId, pushEnabled: true, pushToken: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
  }

  createDevice(data: DeviceCreateData): Promise<Device> {
    return this.db.device.create({ data });
  }

  updateDevice(id: string, data: DeviceUpdateData): Promise<Device> {
    return this.db.device.update({ where: { id }, data });
  }

  async anonymiseDevices(userId: string): Promise<number> {
    const result = await this.db.device.updateMany({
      where: { userId },
      data: {
        pushToken: null,
        pushEnabled: false,
        fingerprint: null,
        model: null,
        appVersion: null,
      },
    });
    return result.count;
  }

  async detachPushToken(pushToken: string, exceptDeviceId: string): Promise<number> {
    const result = await this.db.device.updateMany({
      where: { pushToken, id: { not: exceptDeviceId } },
      data: { pushToken: null, pushEnabled: false },
    });
    return result.count;
  }

  async clearPushTokens(filter: PushTokenClearFilter): Promise<number> {
    const result = await this.db.device.updateMany({
      where: { userId: filter.userId, ...(filter.deviceId ? { id: filter.deviceId } : {}) },
      data: { pushToken: null, pushEnabled: false },
    });
    return result.count;
  }

  // -- consents ---------------------------------------------------------------------------

  listConsents(userId: string): Promise<Consent[]> {
    return this.db.consent.findMany({
      where: { userId },
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    });
  }

  async listMarketingAudience(afterUserId: string | null, limit: number): Promise<string[]> {
    // Latest marketing consent per user (same ordering as domain/consents.ts latestConsentRows),
    // served by the consents (user_id, purpose) index; users walked by primary key.
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT u.id::text AS id
      FROM users u
      JOIN LATERAL (
        SELECT c.revoked_at
        FROM consents c
        WHERE c.user_id = u.id AND c.purpose = 'marketing'
        ORDER BY c.granted_at DESC, c.id DESC
        LIMIT 1
      ) latest ON true
      WHERE u.status = 'active'
        AND latest.revoked_at IS NULL
        AND (${afterUserId}::uuid IS NULL OR u.id > ${afterUserId}::uuid)
      ORDER BY u.id ASC
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  createConsent(data: ConsentCreateData): Promise<Consent> {
    return this.db.consent.create({ data });
  }

  revokeConsent(id: string, revokedAt: Date): Promise<Consent> {
    return this.db.consent.update({ where: { id }, data: { revokedAt } });
  }

  // -- OTP challenges ---------------------------------------------------------------------

  findLatestOtpChallenge(phone: string): Promise<OtpChallenge | null> {
    return this.db.otpChallenge.findFirst({
      where: { phone },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  countOtpChallenges(filter: OtpChallengeCountFilter): Promise<number> {
    return this.db.otpChallenge.count({
      where: {
        ...(filter.phone ? { phone: filter.phone } : {}),
        ...(filter.ip ? { ip: filter.ip } : {}),
        createdAt: { gt: filter.since },
      },
    });
  }

  listOtpPhoneHistory(phone: string, since: Date): Promise<OtpPhoneHistoryRow[]> {
    return this.db.otpChallenge.findMany({
      where: { phone, createdAt: { gt: since } },
      select: { createdAt: true, attempts: true, consumedAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1000,
    });
  }

  async listOtpRequestTimes(filter: OtpRequestTimesFilter, limit: number): Promise<Date[]> {
    const rows = await this.db.otpChallenge.findMany({
      where: { ip: filter.ip, createdAt: { gt: filter.since } },
      select: { createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((row) => row.createdAt);
  }

  async lockOtpRequest(phone: string, ipKey: string | null): Promise<void> {
    this.requireTx('lockOtpRequest');
    // Two-key form: class 7101 = phone, 7102 = IP key, so phone and IP hashes never collide.
    // Always phone first, then IP: no two requests can wait on each other in opposite order.
    // Relies on READ COMMITTED (withTx default): the counts read after the lock see the row the
    // previous holder committed.
    await this.db.$executeRaw`SELECT pg_advisory_xact_lock(7101, hashtext(${phone}))`;
    if (ipKey) {
      await this.db.$executeRaw`SELECT pg_advisory_xact_lock(7102, hashtext(${ipKey}))`;
    }
  }

  createOtpChallenge(data: OtpChallengeCreateData): Promise<OtpChallenge> {
    return this.db.otpChallenge.create({ data: { ...data, attempts: 0 } });
  }

  async recordOtpAttempt(id: string, attempts: number): Promise<void> {
    await this.db.otpChallenge.update({ where: { id }, data: { attempts } });
  }

  async claimOtpAttempt(id: string, maxAttempts: number): Promise<number | null> {
    // Single conditional UPDATE: concurrent verifications serialise on the row lock, so the
    // counter can never pass maxAttempts.
    const result = await this.db.otpChallenge.updateMany({
      where: { id, consumedAt: null, attempts: { lt: maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (result.count !== 1) {
      return null;
    }
    const row = await this.db.otpChallenge.findUnique({
      where: { id },
      select: { attempts: true },
    });
    return row?.attempts ?? null;
  }

  async consumeOtpChallenge(id: string, consumedAt: Date): Promise<boolean> {
    const result = await this.db.otpChallenge.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt },
    });
    return result.count === 1;
  }

  async deleteOtpChallenges(filter: OtpChallengeDeleteFilter): Promise<number> {
    const result = await this.db.otpChallenge.deleteMany({
      where: {
        ...(filter.phone ? { phone: filter.phone } : {}),
        ...(filter.createdBefore ? { createdAt: { lt: filter.createdBefore } } : {}),
      },
    });
    return result.count;
  }

  // -- refresh tokens ---------------------------------------------------------------------

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.db.refreshToken.findUnique({ where: { tokenHash } });
  }

  listActiveSessions(userId: string, now: Date): Promise<RefreshToken[]> {
    return this.db.refreshToken.findMany({
      where: { userId, revokedAt: null, replacedById: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
  }

  listRefreshTokens(userId: string, limit: number): Promise<RefreshToken[]> {
    return this.db.refreshToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  createRefreshToken(data: RefreshTokenCreateData): Promise<RefreshToken> {
    return this.db.refreshToken.create({ data });
  }

  async claimRefreshToken(id: string, now: Date): Promise<boolean> {
    const result = await this.db.refreshToken.updateMany({
      where: { id, revokedAt: null, replacedById: null },
      data: { revokedAt: now },
    });
    return result.count === 1;
  }

  async linkReplacedBy(id: string, successorId: string): Promise<void> {
    await this.db.refreshToken.update({ where: { id }, data: { replacedById: successorId } });
  }

  async revokeRefreshTokens(filter: RefreshTokenRevokeFilter, now: Date): Promise<number> {
    const result = await this.db.refreshToken.updateMany({
      where: {
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.family ? { family: filter.family } : {}),
        ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
        ...(filter.exceptId ? { id: { not: filter.exceptId } } : {}),
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    return result.count;
  }

  async deleteRefreshTokens(before: Date): Promise<number> {
    const result = await this.db.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }] },
    });
    return result.count;
  }

  // -- deletion requests ------------------------------------------------------------------

  findDeletionRequestById(id: string): Promise<AccountDeletionRequest | null> {
    return this.db.accountDeletionRequest.findUnique({ where: { id } });
  }

  findPendingDeletionRequest(userId: string): Promise<AccountDeletionRequest | null> {
    return this.db.accountDeletionRequest.findFirst({
      where: { userId, executedAt: null, cancelledAt: null },
      orderBy: { requestedAt: 'desc' },
    });
  }

  listDeletionRequests(userId: string): Promise<AccountDeletionRequest[]> {
    return this.db.accountDeletionRequest.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  listDueDeletionRequests(now: Date, limit: number): Promise<AccountDeletionRequest[]> {
    return this.db.accountDeletionRequest.findMany({
      where: { executedAt: null, cancelledAt: null, executeAfter: { lte: now } },
      orderBy: { executeAfter: 'asc' },
      take: limit,
    });
  }

  createDeletionRequest(data: DeletionRequestCreateData): Promise<AccountDeletionRequest> {
    return this.db.accountDeletionRequest.create({ data });
  }

  updateDeletionRequest(
    id: string,
    data: DeletionRequestUpdateData,
  ): Promise<AccountDeletionRequest> {
    return this.db.accountDeletionRequest.update({ where: { id }, data });
  }

  // -- admin users ------------------------------------------------------------------------

  findAdminById(id: string): Promise<AdminUser | null> {
    return this.db.adminUser.findUnique({ where: { id } });
  }

  findAdminByEmail(email: string): Promise<AdminUser | null> {
    return this.db.adminUser.findUnique({ where: { email } });
  }

  listAdmins(): Promise<AdminUser[]> {
    return this.db.adminUser.findMany({ orderBy: { createdAt: 'asc' } });
  }

  countActiveOwners(): Promise<number> {
    return this.db.adminUser.count({ where: { role: 'owner', active: true } });
  }

  createAdmin(data: AdminCreateData): Promise<AdminUser> {
    return translateConflict('admin_user', () => this.db.adminUser.create({ data }));
  }

  updateAdmin(id: string, data: AdminUpdateData): Promise<AdminUser> {
    return translateConflict('admin_user', () => this.db.adminUser.update({ where: { id }, data }));
  }

  async claimTotpStep(adminId: string, step: number): Promise<boolean> {
    const result = await this.db.adminUser.updateMany({
      where: {
        id: adminId,
        OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
      },
      data: { totpLastStep: step },
    });
    return result.count === 1;
  }

  async recordAdminLoginFailure(
    adminId: string,
    now: Date,
    policy: AdminLockPolicy,
  ): Promise<AdminFailureUpdate | null> {
    this.requireTx('recordAdminLoginFailure');
    const rows = await this.db.$queryRaw<
      Array<{
        failed_login_count: number;
        last_failed_login_at: Date | null;
        locked_until: Date | null;
      }>
    >`SELECT failed_login_count, last_failed_login_at, locked_until
      FROM admin_users WHERE id = ${adminId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) {
      return null;
    }
    const next = registerAdminLoginFailure(
      {
        failedLoginCount: row.failed_login_count,
        lastFailedLoginAt: row.last_failed_login_at,
        lockedUntil: row.locked_until,
      },
      now,
      policy,
    );
    await this.db.adminUser.update({
      where: { id: adminId },
      data: {
        failedLoginCount: next.failedLoginCount,
        lastFailedLoginAt: next.lastFailedLoginAt,
        lockedUntil: next.lockedUntil,
      },
    });
    return next;
  }

  async claimLoginChallengeAttempt(
    adminId: string,
    challengeId: string,
    maxAttempts: number,
  ): Promise<number | null> {
    const result = await this.db.adminUser.updateMany({
      where: {
        id: adminId,
        loginChallengeId: challengeId,
        loginChallengeAttempts: { lt: maxAttempts },
      },
      data: { loginChallengeAttempts: { increment: 1 } },
    });
    if (result.count !== 1) {
      return null;
    }
    const row = await this.db.adminUser.findUnique({
      where: { id: adminId },
      select: { loginChallengeAttempts: true },
    });
    return row?.loginChallengeAttempts ?? null;
  }

  // -- cross-cutting ----------------------------------------------------------------------

  private requireTx(operation: string): void {
    if (!this.tx) {
      throw new Error(`IdentityStore.${operation}() must be called inside run()`);
    }
  }

  async publish(event: TypedOutboxEventInput): Promise<void> {
    if (!this.tx) {
      throw new Error('IdentityStore.publish() must be called inside run()');
    }
    await this.outbox.publish(this.tx, event);
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.auditPort.audit(entry, this.tx);
  }
}

/** Production store: Prisma, interactive transactions through PrismaService.withTx. */
@Injectable()
export class PrismaIdentityStore extends IdentityStore {
  private readonly root: PrismaIdentityUow;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    @Inject(ADMIN_AUDIT_PORT) private readonly auditPort: AdminAuditPort,
  ) {
    super();
    this.root = new PrismaIdentityUow(prisma, undefined, outbox, auditPort);
  }

  run<T>(fn: (uow: IdentityUow) => Promise<T>): Promise<T> {
    return this.prisma.withTx((tx) =>
      fn(new PrismaIdentityUow(tx, tx, this.outbox, this.auditPort)),
    );
  }

  bind(tx?: Tx): IdentityReads {
    return tx ? new PrismaIdentityUow(tx, tx, this.outbox, this.auditPort) : this.root;
  }
}
