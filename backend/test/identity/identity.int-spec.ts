import { uuidv7 } from 'uuidv7';
import { IDENTITY_EVENTS } from '../../src/common/contracts/events';
import { ACCOUNT_DELETION_DELAY_DAYS } from '../../src/common/contracts/identity';
import { anonymisedPhone } from '../../src/modules/identity/domain/deletion';
import { AccountDeletionService } from '../../src/modules/identity/services/account-deletion.service';
import { AuthService } from '../../src/modules/identity/services/auth.service';
import { ChildrenService } from '../../src/modules/identity/services/children.service';
import {
  IdentityStore,
  StoreConflictError,
} from '../../src/modules/identity/services/identity.store';
import { SessionService } from '../../src/modules/identity/services/session.service';
import { SmsPort } from '../../src/modules/identity/services/sms.port';
import { captureAsyncError } from '../../src/modules/identity/testing/errors';
import { InMemorySmsAdapter } from '../../src/modules/identity/testing/in-memory-sms.adapter';
import { createTestApp, type TestApp } from '../utils/app-factory';
import { describeWithDb, resetDatabase } from '../utils/int';

const PHONE = '+380501234567';
const DEVICE = { platform: 'android' as const, fingerprint: 'int-install-0001', model: 'Pixel 8' };

/** PrismaIdentityStore and the identity services against PostgreSQL (self-skips without DATABASE_URL). */
describeWithDb('identity module (integration)', () => {
  let testApp: TestApp;
  let sms: InMemorySmsAdapter;
  let store: IdentityStore;
  let auth: AuthService;
  let sessions: SessionService;
  let deletions: AccountDeletionService;

  beforeAll(async () => {
    sms = new InMemorySmsAdapter();
    testApp = await createTestApp({
      configure: (builder) => builder.overrideProvider(SmsPort).useValue(sms),
    });
    store = testApp.app.get(IdentityStore);
    auth = testApp.app.get(AuthService);
    sessions = testApp.app.get(SessionService);
    deletions = testApp.app.get(AccountDeletionService);
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await resetDatabase(testApp.prisma);
    testApp.clock?.set('2026-03-10T10:00:00.000Z');
  });

  async function login(phone = PHONE) {
    await auth.requestOtp({ phone, ip: '203.0.113.7' });
    return auth.verifyOtp({ phone, code: sms.lastCode(phone), device: DEVICE });
  }

  it('registers a member and writes the outbox events in the same transaction', async () => {
    const result = await login();
    expect(result.isNewUser).toBe(true);

    const user = await testApp.prisma.user.findUnique({ where: { id: result.user.id } });
    expect(user).toMatchObject({ phone: PHONE, status: 'active' });
    const events = await testApp.prisma.outboxEvent.findMany({
      where: { aggregateId: { in: [result.user.id, result.deviceId] } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((event) => event.type).sort()).toEqual(
      [IDENTITY_EVENTS.deviceRegistered, IDENTITY_EVENTS.registered].sort(),
    );
    const challenge = await testApp.prisma.otpChallenge.findFirst({ where: { phone: PHONE } });
    expect(challenge?.consumedAt).not.toBeNull();
    expect(challenge?.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caps parallel wrong guesses at maxAttempts with the conditional update', async () => {
    await auth.requestOtp({ phone: PHONE, ip: '203.0.113.7' });
    const good = sms.lastCode(PHONE);
    const bad = good === '000000' ? '111111' : '000000';
    await Promise.all(
      Array.from({ length: 8 }, () =>
        captureAsyncError(auth.verifyOtp({ phone: PHONE, code: bad, device: DEVICE })),
      ),
    );
    const challenge = await testApp.prisma.otpChallenge.findFirst({ where: { phone: PHONE } });
    expect(challenge?.attempts).toBe(5);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const first = await login();
    const rotated = await sessions.refresh(first.refreshToken);
    testApp.clock?.advanceSeconds(30);
    await expect(sessions.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_REUSED',
    });
    const active = await testApp.prisma.refreshToken.count({
      where: { userId: first.user.id, revokedAt: null },
    });
    expect(active).toBe(0);
    await expect(sessions.refresh(rotated.session.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
  });

  it('translates unique violations and rolls back the unit of work', async () => {
    const first = await login();
    const error = await captureAsyncError(
      store.run(async (uow) => {
        await uow.createUser({
          id: uuidv7(),
          phone: '+380671112233',
          memberCode: '200000007',
          createdAt: new Date(),
        });
        await uow.createUser({
          id: uuidv7(),
          phone: PHONE,
          memberCode: '300000005',
          createdAt: new Date(),
        });
      }),
    );
    expect(StoreConflictError.is(error)).toBe(true);
    expect((error as StoreConflictError).has('phone')).toBe(true);
    await expect(store.findUserByPhone('+380671112233')).resolves.toBeNull();
    await expect(store.findUserByPhone(PHONE)).resolves.toMatchObject({ id: first.user.id });
  });

  it('finds members by phone fragment, member code and name', async () => {
    const member = await login();
    await store.run((uow) =>
      uow.updateUser(member.user.id, { firstName: 'Олег', lastName: 'Демо' }),
    );
    const byFragment = await store.searchUsers({ terms: { digitFragment: '1234' }, limit: 10 });
    const byCode = await store.searchUsers({
      terms: { memberCode: member.user.memberCode },
      limit: 10,
    });
    const byName = await store.searchUsers({ terms: { name: 'олег' }, limit: 10 });
    for (const rows of [byFragment, byCode, byName]) {
      expect(rows.map((row) => row.id)).toEqual([member.user.id]);
    }
  });

  it('anonymises a member after the cooling-off period and audits it', async () => {
    const member = await login();
    const { request } = await deletions.requestDeletion(member.user.id, 'int test');
    testApp.clock?.advanceDays(ACCOUNT_DELETION_DELAY_DAYS);

    await expect(deletions.executeDue(10)).resolves.toMatchObject({ executed: 1, failed: 0 });

    const user = await testApp.prisma.user.findUnique({ where: { id: member.user.id } });
    expect(user).toMatchObject({
      phone: anonymisedPhone(member.user.id),
      status: 'deleted',
      firstName: null,
    });
    const executed = await testApp.prisma.accountDeletionRequest.findUnique({
      where: { id: request.id },
    });
    expect(executed?.executedAt).not.toBeNull();
    const audit = await testApp.prisma.auditLog.findFirst({
      where: { entityId: member.user.id, action: 'user.anonymise' },
    });
    expect(audit).not.toBeNull();
    await expect(
      testApp.prisma.outboxEvent.count({ where: { type: IDENTITY_EVENTS.deleted } }),
    ).resolves.toBe(1);
  });

  it('lists the marketing audience by the latest consent, paged by user id', async () => {
    const at = (minute: number): Date => new Date(Date.UTC(2026, 2, 10, 9, minute));
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7()].sort();
    const [granted, revokedLater, regranted, blocked] = ids as [string, string, string, string];
    for (const [index, id] of ids.entries()) {
      await testApp.prisma.user.create({
        data: {
          id,
          phone: `+38050111000${index}`,
          memberCode: `20000000${index}`,
          status: id === blocked ? 'blocked' : 'active',
        },
      });
    }
    const consent = (userId: string, minute: number, revoked: boolean) =>
      testApp.prisma.consent.create({
        data: {
          id: uuidv7(),
          userId,
          purpose: 'marketing',
          version: '2026-10',
          grantedAt: at(minute),
          revokedAt: revoked ? at(minute + 1) : null,
        },
      });
    await consent(granted, 1, false);
    await consent(revokedLater, 1, false);
    await consent(revokedLater, 5, true);
    await consent(regranted, 1, true);
    await consent(regranted, 5, false);
    await consent(blocked, 1, false);

    await expect(store.listMarketingAudience(null, 10)).resolves.toEqual(
      [granted, regranted].sort(),
    );
    const firstPage = await store.listMarketingAudience(null, 1);
    expect(firstPage).toHaveLength(1);
    await expect(store.listMarketingAudience(firstPage[0] ?? null, 10)).resolves.toEqual(
      [granted, regranted].sort().slice(1),
    );
  });

  it('makes the OTP count-then-insert atomic under parallel requests (advisory lock)', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        auth.requestOtp({ phone: '+380671234567', ip: `198.51.100.${index}` }),
      ),
    );
    const created = await testApp.prisma.otpChallenge.count({ where: { phone: '+380671234567' } });
    // The default 60 s cooldown lets exactly one of the parallel requests through.
    expect(created).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(
      store.listOtpPhoneHistory('+380671234567', new Date('2026-03-10T00:00:00.000Z')),
    ).resolves.toHaveLength(1);
  });

  it('stores the IPv6 /64 network as the OTP rate-limit key', async () => {
    await auth.requestOtp({ phone: '+380671234568', ip: '2001:db8:1:2::abcd' });
    const row = await testApp.prisma.otpChallenge.findFirst({ where: { phone: '+380671234568' } });
    expect(row?.ip).toBe('2001:db8:1:2::/64');
    await expect(
      store.listOtpRequestTimes(
        { ip: '2001:db8:1:2::/64', since: new Date('2026-03-10T09:00:00.000Z') },
        10,
      ),
    ).resolves.toHaveLength(1);
  });

  it('counts failed admin logins under a row lock and claims challenge attempts atomically', async () => {
    const adminId = uuidv7();
    await testApp.prisma.adminUser.create({
      data: {
        id: adminId,
        email: 'lock@portcity.local',
        passwordHash: 'x',
        role: 'support',
        loginChallengeId: '0190a000-0000-7000-8000-00000000c0de',
      },
    });
    const now = new Date('2026-03-10T10:00:00.000Z');
    const policy = { threshold: 5, baseSeconds: 300, maxSeconds: 3600, windowSeconds: 86_400 };
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.run((uow) => uow.recordAdminLoginFailure(adminId, now, policy)),
      ),
    );
    await expect(
      testApp.prisma.adminUser.findUnique({ where: { id: adminId } }),
    ).resolves.toMatchObject({
      failedLoginCount: 5,
      lockedUntil: new Date('2026-03-10T10:05:00.000Z'),
    });

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.run((uow) =>
          uow.claimLoginChallengeAttempt(adminId, '0190a000-0000-7000-8000-00000000c0de', 5),
        ),
      ),
    );
    expect(claims.filter((claim) => claim !== null)).toHaveLength(5);
    await expect(
      store.run((uow) =>
        uow.claimLoginChallengeAttempt(adminId, '0190a000-0000-7000-8000-00000000beef', 5),
      ),
    ).resolves.toBeNull();
  });

  it('caps children at six under parallel requests and announces the field once', async () => {
    const member = await login();
    const children = testApp.app.get(ChildrenService);
    await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        children.create(member.user.id, { birthMonth: index + 1, birthYear: 2020 }),
      ),
    );
    await expect(testApp.prisma.child.count({ where: { userId: member.user.id } })).resolves.toBe(
      6,
    );
    const user = await testApp.prisma.user.findUnique({ where: { id: member.user.id } });
    expect(user?.completedProfileFields).toEqual(['children']);
    await expect(
      testApp.prisma.outboxEvent.count({
        where: { type: IDENTITY_EVENTS.profileFieldCompleted, aggregateId: member.user.id },
      }),
    ).resolves.toBe(1);
  });

  it('claims TOTP steps atomically and refuses replays', async () => {
    const adminId = uuidv7();
    await testApp.prisma.adminUser.create({
      data: { id: adminId, email: 'totp@portcity.local', passwordHash: 'x', role: 'owner' },
    });
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.run((uow) => uow.claimTotpStep(adminId, 1000))),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(store.run((uow) => uow.claimTotpStep(adminId, 999))).resolves.toBe(false);
    await expect(store.run((uow) => uow.claimTotpStep(adminId, 1001))).resolves.toBe(true);
    await expect(
      testApp.prisma.adminUser.findUnique({ where: { id: adminId } }),
    ).resolves.toMatchObject({ totpLastStep: 1001 });
  });
});
