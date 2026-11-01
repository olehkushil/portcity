import request from 'supertest';
import { hashPassword, scryptParamsWithLogN } from '../../src/common/auth/crypto';
import { IDENTITY_PORT, type IdentityPort } from '../../src/common/contracts/identity';
import { buildOpenApiDocument } from '../../src/common/openapi/openapi';
import { FakeClock } from '../../src/common/time/clock';
import { generateTotpCode } from '../../src/modules/identity/domain/totp';
import { IDENTITY_CONFIG } from '../../src/modules/identity/identity.config';
import { IdentityPortService } from '../../src/modules/identity/services/identity-port.service';
import { IdentityStore } from '../../src/modules/identity/services/identity.store';
import { SmsPort } from '../../src/modules/identity/services/sms.port';
import { makeIdentityConfig } from '../../src/modules/identity/testing/fixtures';
import { InMemoryIdentityStore } from '../../src/modules/identity/testing/in-memory-identity.store';
import { InMemorySmsAdapter } from '../../src/modules/identity/testing/in-memory-sms.adapter';
import { createTestApp, type TestApp } from '../utils/app-factory';

const PHONE = '+380501234567';
const ADMIN_ID = '0190a000-0000-7000-8000-0000000000aa';
const SUPPORT_ID = '0190a000-0000-7000-8000-0000000000ab';
const MANAGER_ID = '0190a000-0000-7000-8000-0000000000ac';
const INACTIVE_ID = '0190a000-0000-7000-8000-0000000000ad';
const LOCKABLE_ID = '0190a000-0000-7000-8000-0000000000ae';
const ADMIN_PASSWORD = 'Admin-Password-2026';
const API = '/api/v1';

interface LoginBody {
  accessToken: string;
  refreshToken: string;
  isNewUser: boolean;
  deviceId: string;
  user: { id: string; memberCode: string; phone: string };
}

describe('identity HTTP API (e2e, in-memory store)', () => {
  let testApp: TestApp;
  let clock: FakeClock;
  let store: InMemoryIdentityStore;
  let sms: InMemorySmsAdapter;
  let member: LoginBody;

  beforeAll(async () => {
    clock = new FakeClock('2026-03-10T10:00:00.000Z');
    store = new InMemoryIdentityStore(() => clock.now());
    sms = new InMemorySmsAdapter();
    // Admin hashes at the test cost (ln=10), matching ADMIN_PASSWORD_SCRYPT_LOG_N below.
    const passwordHash = await hashPassword(ADMIN_PASSWORD, scryptParamsWithLogN(10));
    store.seedAdmin({
      id: LOCKABLE_ID,
      email: 'lockable@portcity.local',
      passwordHash,
      role: 'support',
    });
    store.seedAdmin({
      id: ADMIN_ID,
      email: 'admin@portcity.local',
      passwordHash,
      role: 'owner',
    });
    store.seedAdmin({
      id: SUPPORT_ID,
      email: 'support@portcity.local',
      passwordHash,
      role: 'support',
    });
    store.seedAdmin({
      id: MANAGER_ID,
      email: 'manager@portcity.local',
      passwordHash,
      role: 'manager',
    });
    store.seedAdmin({
      id: INACTIVE_ID,
      email: 'former@portcity.local',
      passwordHash,
      role: 'manager',
      active: false,
    });
    testApp = await createTestApp({
      clock,
      // The shared AdminGuard asks identity (the in-memory store here) about every admin token.
      adminAccessCheck: true,
      configure: (builder) =>
        builder
          .overrideProvider(IdentityStore)
          .useValue(store)
          .overrideProvider(SmsPort)
          .useValue(sms)
          // Production defaults (60 s resend cooldown, TOTP required for owner/manager, lockout)
          // except the scrypt cost of admin passwords, lowered for speed.
          .overrideProvider(IDENTITY_CONFIG)
          .useValue(
            makeIdentityConfig({
              OTP_RESEND_COOLDOWN_SECONDS: '60',
              ACCOUNT_DELETION_GRACE_DAYS: '21',
            }),
          ),
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  const server = () => testApp.server;
  const bearer = (token: string) => `Bearer ${token}`;

  it('provides IDENTITY_PORT with the real service', () => {
    expect(testApp.moduleRef.get<IdentityPort>(IDENTITY_PORT, { strict: false })).toBeInstanceOf(
      IdentityPortService,
    );
  });

  it('documents every identity endpoint in the OpenAPI document', () => {
    const document = buildOpenApiDocument(testApp.app);
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${path.replace(/^\/api\/v1/, '')}`),
    );
    expect(operations).toEqual(
      expect.arrayContaining([
        'POST /auth/otp/request',
        'POST /auth/otp/verify',
        'POST /auth/refresh',
        'POST /auth/logout',
        'GET /me',
        'PATCH /me',
        'DELETE /me',
        'POST /me/consents',
        'GET /me/devices',
        'POST /me/devices',
        'DELETE /me/devices/{id}',
        'DELETE /me/deletion',
        'GET /me/export',
        'GET /me/children',
        'POST /me/children',
        'PATCH /me/children/{id}',
        'DELETE /me/children/{id}',
        'GET /legal/documents',
        'POST /admin/auth/login',
        'POST /admin/auth/totp',
        'POST /admin/auth/totp/enroll',
        'POST /admin/auth/totp/enroll/confirm',
        'GET /admin/auth/me',
        'POST /admin/auth/totp/setup',
        'POST /admin/auth/totp/confirm',
        'POST /admin/auth/totp/disable',
        'GET /admin/users',
        'GET /admin/users/{id}',
        'POST /admin/users/{id}/block',
        'POST /admin/users/{id}/unblock',
        'POST /admin/users/{id}/revoke-sessions',
        'GET /admin/admin-users',
        'POST /admin/admin-users',
        'PATCH /admin/admin-users/{id}',
      ]),
    );
    expect(document.components?.schemas).toHaveProperty('AdminMemberDto');
  });

  it('validates the OTP request body', async () => {
    const response = await request(server()).post(`${API}/auth/otp/request`).send({});
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
  });

  it('logs a member in with an SMS code', async () => {
    const requested = await request(server())
      .post(`${API}/auth/otp/request`)
      .send({ phone: '050 123 45 67' });
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({
      phone: PHONE,
      codeLength: 6,
      maxAttempts: 5,
      resendAvailableAt: '2026-03-10T10:01:00.000Z',
    });
    expect(requested.body).not.toHaveProperty('debugCode');

    const missingDevice = await request(server())
      .post(`${API}/auth/otp/verify`)
      .send({ phone: PHONE, code: sms.lastCode(PHONE) });
    expect(missingDevice.status).toBe(400);

    const verified = await request(server())
      .post(`${API}/auth/otp/verify`)
      .send({
        phone: PHONE,
        code: sms.lastCode(PHONE),
        device: {
          platform: 'ios',
          model: 'iPhone 15',
          appVersion: '1.0.0',
          fingerprint: 'e2e-install-0001',
        },
        // No version: the current program text of GET /legal/documents is accepted.
        consents: [{ purpose: 'program', granted: true }],
      });
    expect(verified.status).toBe(200);
    member = verified.body as LoginBody;
    expect(member).toMatchObject({ isNewUser: true, tokenType: 'Bearer', user: { phone: PHONE } });
    expect(store.eventTypes()).toContain('user.registered');
    expect([...store.state.consents.values()]).toEqual([
      expect.objectContaining({ purpose: 'program', version: '2026-10' }),
    ]);
  });

  it('refuses a resend inside the cooldown with the retry time', async () => {
    const phone = '+380931112233';
    const first = await request(server()).post(`${API}/auth/otp/request`).send({ phone });
    expect(first.status).toBe(200);
    const again = await request(server()).post(`${API}/auth/otp/request`).send({ phone });
    expect(again.status).toBe(429);
    expect(again.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(again.body).toMatchObject({
      code: 'PC_OTP_RATE_LIMITED',
      details: { scope: 'cooldown', retryAfterSeconds: 60, retryAt: '2026-03-10T10:01:00.000Z' },
    });
  });

  it('serves the current legal documents publicly', async () => {
    const response = await request(server()).get(`${API}/legal/documents`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      documents: [
        expect.objectContaining({ purpose: 'program', version: '2026-10', required: true }),
        expect.objectContaining({ purpose: 'marketing', version: '2026-10', required: false }),
        expect.objectContaining({ purpose: 'profiling', version: '2026-10', required: false }),
      ],
      privacyPolicyUrl: 'https://portcity.com.ua/privacy',
    });
  });

  it('rejects a wrong code with the attempts left', async () => {
    await request(server()).post(`${API}/auth/otp/request`).send({ phone: '+380671112233' });
    const good = sms.lastCode('+380671112233');
    const response = await request(server())
      .post(`${API}/auth/otp/verify`)
      .send({
        phone: '+380671112233',
        code: good === '000000' ? '111111' : '000000',
        device: { platform: 'android' },
      });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'PC_OTP_INVALID', details: { attemptsLeft: 4 } });
  });

  it('serves and updates the profile', async () => {
    expect((await request(server()).get(`${API}/me`)).status).toBe(401);

    const profile = await request(server())
      .get(`${API}/me`)
      .set('Authorization', bearer(member.accessToken));
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({
      user: { id: member.user.id, profileCompleted: false },
      currentDevice: { id: member.deviceId, current: true },
      deletionRequest: null,
    });

    const patched = await request(server())
      .patch(`${API}/me`)
      .set('Authorization', bearer(member.accessToken))
      .send({ firstName: 'Олег', lastName: 'Демо', birthDate: '1990-05-14' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ user: { profileCompleted: true } });

    const badDate = await request(server())
      .patch(`${API}/me`)
      .set('Authorization', bearer(member.accessToken))
      .send({ birthDate: '14.05.1990' });
    expect(badDate.status).toBe(400);

    const unknownField = await request(server())
      .patch(`${API}/me`)
      .set('Authorization', bearer(member.accessToken))
      .send({ phone: '+380999999999' });
    expect(unknownField.status).toBe(400);
  });

  it('stores gender and city, manages children and reports the profile completion', async () => {
    const auth = bearer(member.accessToken);
    const badGender = await request(server())
      .patch(`${API}/me`)
      .set('Authorization', auth)
      .send({ gender: 'robot' });
    expect(badGender.status).toBe(400);

    const patched = await request(server())
      .patch(`${API}/me`)
      .set('Authorization', auth)
      .send({ gender: 'male', city: 'Луцьк' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      user: { gender: 'male', city: 'Луцьк' },
      profileCompletion: { percent: 71, missing: ['email', 'children'], bonusPerField: 10 },
    });

    const created = await request(server())
      .post(`${API}/me/children`)
      .set('Authorization', auth)
      .send({ birthMonth: 5, birthYear: 2019, gender: 'female' });
    expect(created.status).toBe(201);
    const childId = (created.body as { id: string }).id;

    const invalid = await request(server())
      .post(`${API}/me/children`)
      .set('Authorization', auth)
      .send({ birthMonth: 13, birthYear: 2019 });
    expect(invalid.status).toBe(400);
    const future = await request(server())
      .post(`${API}/me/children`)
      .set('Authorization', auth)
      .send({ birthMonth: 12, birthYear: 2026 });
    expect(future.status).toBe(422);
    expect(future.body).toMatchObject({ code: 'PC_USER_CHILD_BIRTH_INVALID' });

    const changed = await request(server())
      .patch(`${API}/me/children/${childId}`)
      .set('Authorization', auth)
      .send({ gender: 'unspecified' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ id: childId, gender: 'unspecified' });

    const list = await request(server()).get(`${API}/me/children`).set('Authorization', auth);
    expect(list.body).toMatchObject({ max: 6, items: [{ id: childId, birthYear: 2019 }] });

    const profile = await request(server()).get(`${API}/me`).set('Authorization', auth);
    expect(profile.body).toMatchObject({
      children: [{ id: childId }],
      profileCompletion: { missing: ['email'] },
    });
    expect(
      store.eventTypes().filter((type) => type === 'user.profile_field_completed'),
    ).toHaveLength(6);

    const removed = await request(server())
      .delete(`${API}/me/children/${childId}`)
      .set('Authorization', auth);
    expect(removed.status).toBe(204);
    const missing = await request(server())
      .delete(`${API}/me/children/${childId}`)
      .set('Authorization', auth);
    expect(missing.status).toBe(404);
  });

  it('updates consents and the push token of the current device', async () => {
    const consents = await request(server())
      .post(`${API}/me/consents`)
      .set('Authorization', bearer(member.accessToken))
      .send({ consents: [{ purpose: 'marketing', granted: true, version: '2026-10' }] });
    expect(consents.status).toBe(200);
    expect(consents.body.consents).toEqual(
      expect.arrayContaining([expect.objectContaining({ purpose: 'marketing', granted: true })]),
    );

    const device = await request(server())
      .post(`${API}/me/devices`)
      .set('Authorization', bearer(member.accessToken))
      .send({ pushToken: 'fcm-token-e2e' });
    expect(device.status).toBe(200);
    expect(device.body).toMatchObject({
      id: member.deviceId,
      pushEnabled: true,
      hasPushToken: true,
    });

    const devices = await request(server())
      .get(`${API}/me/devices`)
      .set('Authorization', bearer(member.accessToken));
    expect(devices.body.devices).toHaveLength(1);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const rotated = await request(server())
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: member.refreshToken });
    expect(rotated.status).toBe(200);
    const next = rotated.body as LoginBody;
    expect(next.refreshToken).not.toBe(member.refreshToken);

    clock.advanceSeconds(30);
    const reused = await request(server())
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: member.refreshToken });
    expect(reused.status).toBe(401);
    expect(reused.body).toMatchObject({ code: 'PC_REFRESH_REUSED' });

    const afterReuse = await request(server())
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: next.refreshToken });
    expect(afterReuse.body).toMatchObject({ code: 'PC_REFRESH_INVALID' });
  });

  it('exports personal data and handles the deletion request lifecycle', async () => {
    const exported = await request(server())
      .get(`${API}/me/export`)
      .set('Authorization', bearer(member.accessToken));
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ user: { id: member.user.id } });

    const requested = await request(server())
      .delete(`${API}/me`)
      .set('Authorization', bearer(member.accessToken))
      .send({ reason: 'test' });
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({
      created: true,
      request: { status: 'pending' },
      // ACCOUNT_DELETION_GRACE_DAYS=21 in this suite (the clock moved 30 s in the refresh test).
      graceDays: 21,
      executeAfter: '2026-03-31T10:00:30.000Z',
    });

    const cancelled = await request(server())
      .delete(`${API}/me/deletion`)
      .set('Authorization', bearer(member.accessToken));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled' });
  });

  it('logs out the current device', async () => {
    const response = await request(server())
      .post(`${API}/auth/logout`)
      .set('Authorization', bearer(member.accessToken))
      .send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ revokedSessions: expect.any(Number) as number });
  });

  it('makes an owner enrol TOTP at login, then searches members with masked phones', async () => {
    const wrong = await request(server())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'admin@portcity.local', password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: 'PC_ADMIN_CREDENTIALS_INVALID' });

    const login = await request(server())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'admin@portcity.local', password: ADMIN_PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body).toMatchObject({
      code: 'PC_ADMIN_TOTP_SETUP_REQUIRED',
      details: { role: 'owner' },
    });
    const enrollmentToken = (login.body as { details: { enrollmentToken: string } }).details
      .enrollmentToken;

    const setup = await request(server())
      .post(`${API}/admin/auth/totp/enroll`)
      .send({ enrollmentToken });
    expect(setup.status).toBe(200);
    const { secret, setupToken } = setup.body as { secret: string; setupToken: string };

    const confirmed = await request(server())
      .post(`${API}/admin/auth/totp/enroll/confirm`)
      .send({ setupToken, code: generateTotpCode(secret, clock.nowMs()) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ admin: { id: ADMIN_ID, totpEnabled: true } });
    const adminToken = (confirmed.body as { accessToken: string }).accessToken;

    // From now on the password alone only yields the TOTP challenge.
    const next = await request(server())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'admin@portcity.local', password: ADMIN_PASSWORD });
    expect(next.status).toBe(401);
    expect(next.body).toMatchObject({
      code: 'PC_ADMIN_TOTP_REQUIRED',
      details: { maxAttempts: 5 },
    });

    const search = await request(server())
      .get(`${API}/admin/users`)
      .query({ q: '0501234567' })
      .set('Authorization', bearer(adminToken));
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([
      expect.objectContaining({ id: member.user.id, phone: '+380 50 *** ** 67' }),
    ]);

    const card = await request(server())
      .get(`${API}/admin/users/${member.user.id}`)
      .set('Authorization', bearer(adminToken));
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ user: { phone: '+380 50 *** ** 67' } });

    const badId = await request(server())
      .get(`${API}/admin/users/not-a-uuid`)
      .set('Authorization', bearer(adminToken));
    expect(badId.status).toBe(400);

    const staff = await request(server())
      .get(`${API}/admin/admin-users`)
      .set('Authorization', bearer(adminToken));
    expect(staff.status).toBe(200);

    const me = await request(server())
      .get(`${API}/admin/auth/me`)
      .set('Authorization', bearer(adminToken));
    expect(me.body).toMatchObject({ id: ADMIN_ID, role: 'owner' });
  });

  it('locks an admin account after 5 failed logins', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await request(server())
        .post(`${API}/admin/auth/login`)
        .send({ email: 'lockable@portcity.local', password: 'not-the-password' });
      expect(failed.status).toBe(401);
    }
    const locked = await request(server())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'lockable@portcity.local', password: ADMIN_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({
      code: 'PC_ADMIN_LOGIN_LOCKED',
      details: { retryAfterSeconds: 300 },
    });
    expect(store.audits.map((entry) => entry.action)).toContain('admin_user.login_locked');
  });

  it('keeps members and lower roles out of admin endpoints', async () => {
    const asMember = await request(server())
      .get(`${API}/admin/users`)
      .set('Authorization', bearer(testApp.memberToken(member.user.id)));
    expect(asMember.status).toBe(403);

    const asSupport = await request(server())
      .get(`${API}/admin/admin-users`)
      .set('Authorization', bearer(testApp.adminToken(SUPPORT_ID, ['support'])));
    expect(asSupport.status).toBe(403);
    expect(asSupport.body).toMatchObject({ code: 'PC_AUTH_FORBIDDEN' });

    const unknownAdmin = await request(server())
      .get(`${API}/admin/users`)
      .set(
        'Authorization',
        bearer(testApp.adminToken('0190a000-0000-7000-8000-0000000000ff', ['manager'])),
      );
    expect(unknownAdmin.status).toBe(403);
    expect(unknownAdmin.body).toMatchObject({ code: 'PC_ADMIN_INACTIVE' });
  });

  it('refuses tokens of deactivated admins on every module, through the shared AdminGuard', async () => {
    const token = bearer(testApp.adminToken(INACTIVE_ID, ['manager']));
    const users = await request(server()).get(`${API}/admin/users`).set('Authorization', token);
    expect(users.status).toBe(403);
    expect(users.body).toMatchObject({ code: 'PC_ADMIN_INACTIVE' });

    // An endpoint hosted by another module (admin): the check runs before its handler.
    const flags = await request(server())
      .get(`${API}/admin/feature-flags`)
      .set('Authorization', token);
    expect(flags.status).toBe(403);
    expect(flags.body).toMatchObject({ code: 'PC_ADMIN_INACTIVE' });
  });

  it('refuses a token whose role no longer matches the account', async () => {
    const response = await request(server())
      .get(`${API}/admin/users`)
      .set('Authorization', bearer(testApp.adminToken(ADMIN_ID, ['support'])));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'PC_AUTH_TOKEN_INVALID' });
  });

  it('applies a deactivation by the owner to the next request at once', async () => {
    const owner = bearer(testApp.adminToken(ADMIN_ID, ['owner']));
    const managerToken = bearer(testApp.adminToken(MANAGER_ID, ['manager']));
    const before = await request(server())
      .get(`${API}/admin/users`)
      .set('Authorization', managerToken);
    expect(before.status).toBe(200);

    const deactivate = await request(server())
      .patch(`${API}/admin/admin-users/${MANAGER_ID}`)
      .set('Authorization', owner)
      .send({ active: false });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body).toMatchObject({ id: MANAGER_ID, active: false });

    const after = await request(server())
      .get(`${API}/admin/users`)
      .set('Authorization', managerToken);
    expect(after.status).toBe(403);
    expect(after.body).toMatchObject({ code: 'PC_ADMIN_INACTIVE' });
  });
});
