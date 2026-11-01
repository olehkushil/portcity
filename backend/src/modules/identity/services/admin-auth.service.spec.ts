import { Logger } from '@nestjs/common';
import type { AdminRole } from '@prisma/client';
import { hashPassword, scryptParamsWithLogN } from '../../../common/auth/crypto';
import { generateTotpCode, generateTotpSecret } from '../domain/totp';
import {
  captureAsyncError,
  createIdentityHarness,
  type IdentityHarness,
} from '../testing/fixtures';

const PASSWORD = 'Correct-Horse-2026';
const ADMIN_ID = '0190a000-0000-7000-8000-000000000001';
const EMAIL = 'admin@portcity.local';
/** The harness hashes admin passwords with ln=10 (production 17). */
const TEST_PARAMS = scryptParamsWithLogN(10);

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, TEST_PARAMS);
});

function withAdmin(
  overrides: {
    totpSecret?: string | null;
    active?: boolean;
    role?: AdminRole;
    passwordHash?: string;
  } = {},
  identity: Record<string, string> = {},
): IdentityHarness {
  const h = createIdentityHarness({ identity });
  h.store.seedAdmin({
    id: ADMIN_ID,
    email: EMAIL,
    passwordHash: overrides.passwordHash ?? passwordHash,
    role: overrides.role ?? 'moderator',
    totpSecret: overrides.totpSecret ?? null,
    active: overrides.active ?? true,
  });
  return h;
}

function detailOf(error: unknown, key: string): string {
  const details = (error as { details?: Record<string, unknown> }).details;
  const value = details?.[key];
  if (typeof value !== 'string') {
    throw new Error(`No ${key} in the error details`);
  }
  return value;
}

const challengeOf = (error: unknown): string => detailOf(error, 'challengeToken');
const login = (
  h: IdentityHarness,
  password = PASSWORD,
  extra: { code?: string; ip?: string } = {},
) => h.adminAuth.login({ email: EMAIL, password, ...extra });

describe('AdminAuthService.login', () => {
  it('issues an admin token for e-mail and password and audits the login', async () => {
    const h = withAdmin();
    const result = await h.adminAuth.login({
      email: ' Admin@PortCity.local ',
      password: PASSWORD,
      ip: '10.0.0.1',
    });

    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresAt).toBe('2026-03-10T18:00:00.000Z');
    expect(result.admin).toMatchObject({ id: ADMIN_ID, role: 'moderator', totpEnabled: false });
    expect(result.admin.lastLoginAt).toBe('2026-03-10T10:00:00.000Z');
    expect(h.tokens.verifyAccessToken(result.accessToken)).toMatchObject({
      sub: ADMIN_ID,
      typ: 'admin',
      roles: ['moderator'],
    });
    expect(h.store.audits.at(-1)).toMatchObject({
      action: 'admin_user.login',
      entityId: ADMIN_ID,
      ip: '10.0.0.1',
      after: { method: 'password' },
    });
  });

  it('answers the same error for a wrong password and an unknown e-mail', async () => {
    const h = withAdmin();
    await expect(login(h, 'wrong-password')).rejects.toMatchObject({
      code: 'PC_ADMIN_CREDENTIALS_INVALID',
      status: 401,
    });
    expect(h.store.audits.at(-1)).toMatchObject({
      action: 'admin_user.login_failed',
      reason: 'invalid_password',
      after: { failedLoginCount: 1, lockedUntil: null },
    });
    const audits = h.store.audits.length;
    await expect(
      h.adminAuth.login({ email: 'nobody@portcity.local', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'PC_ADMIN_CREDENTIALS_INVALID' });
    expect(h.store.audits.length).toBe(audits);
  });

  it('refuses deactivated accounts after checking the password', async () => {
    const h = withAdmin({ active: false });
    await expect(login(h)).rejects.toMatchObject({ code: 'PC_ADMIN_INACTIVE', status: 403 });
  });

  it('asks for the second factor and completes the login with a challenge', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ totpSecret: secret });
    const error = await captureAsyncError(login(h));
    expect(error).toMatchObject({
      code: 'PC_ADMIN_TOTP_REQUIRED',
      status: 401,
      details: { expiresAt: '2026-03-10T10:05:00.000Z', maxAttempts: 5 },
    });
    const challenge = challengeOf(error);
    expect(h.store.state.admins.get(ADMIN_ID)?.loginChallengeId).toMatch(/^[0-9a-f-]{36}$/);

    const wrong = generateTotpCode(secret, h.clock.nowMs() + 10 * 60_000);
    await expect(h.adminAuth.completeTotp(challenge, wrong)).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_INVALID',
      details: { attemptsLeft: 4 },
    });
    const result = await h.adminAuth.completeTotp(
      challenge,
      generateTotpCode(secret, h.clock.nowMs()),
    );
    expect(result.admin.totpEnabled).toBe(true);
    expect(h.store.audits.at(-1)).toMatchObject({ after: { method: 'password+totp' } });
    expect(h.store.state.admins.get(ADMIN_ID)).toMatchObject({
      loginChallengeId: null,
      failedLoginCount: 0,
    });
  });

  it('accepts password and code in one step', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ totpSecret: secret });
    await expect(
      login(h, PASSWORD, { code: generateTotpCode(secret, h.clock.nowMs()) }),
    ).resolves.toMatchObject({ admin: { id: ADMIN_ID } });
    const wrong = generateTotpCode(secret, h.clock.nowMs() + 10 * 60_000);
    await expect(login(h, PASSWORD, { code: wrong })).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_INVALID',
    });
    expect(h.store.state.admins.get(ADMIN_ID)?.failedLoginCount).toBe(1);
  });

  it('refuses a TOTP code replayed within its window, on both login paths', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ totpSecret: secret });
    const code = generateTotpCode(secret, h.clock.nowMs());
    await expect(login(h, PASSWORD, { code })).resolves.toMatchObject({ admin: { id: ADMIN_ID } });
    const step = Math.floor(h.clock.nowMs() / 30_000);
    expect(h.store.state.admins.get(ADMIN_ID)?.totpLastStep).toBe(step);

    // Same code, 10 s later (still valid for the clock tolerance): replay.
    h.clock.advanceSeconds(10);
    await expect(login(h, PASSWORD, { code })).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_INVALID',
      status: 401,
    });
    expect(h.store.audits.filter((entry) => entry.reason === 'totp_replayed')).toHaveLength(1);
    const challenge = challengeOf(await captureAsyncError(login(h)));
    await expect(h.adminAuth.completeTotp(challenge, code)).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_INVALID',
    });

    // The next step's code works once; the older step stays refused afterwards.
    h.clock.advanceSeconds(30);
    const next = generateTotpCode(secret, h.clock.nowMs());
    await expect(h.adminAuth.completeTotp(challenge, next)).resolves.toMatchObject({
      admin: { id: ADMIN_ID },
    });
    expect(h.store.state.admins.get(ADMIN_ID)?.totpLastStep).toBe(step + 1);
    if (code !== next) {
      await expect(login(h, PASSWORD, { code })).rejects.toMatchObject({
        code: 'PC_ADMIN_TOTP_INVALID',
      });
    }
  });

  it('rejects tampered, expired and outdated challenges', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ totpSecret: secret });
    const challenge = challengeOf(await captureAsyncError(login(h)));
    const code = (): string => generateTotpCode(secret, h.clock.nowMs());

    await expect(h.adminAuth.completeTotp(`${challenge}x`, code())).rejects.toMatchObject({
      code: 'PC_ADMIN_CHALLENGE_INVALID',
    });

    const admin = h.store.state.admins.get(ADMIN_ID);
    if (admin) {
      admin.passwordHash = await hashPassword('Another-Password-2026', TEST_PARAMS);
    }
    await expect(h.adminAuth.completeTotp(challenge, code())).rejects.toMatchObject({
      code: 'PC_ADMIN_CHALLENGE_INVALID',
    });
    if (admin) {
      admin.passwordHash = passwordHash;
    }
    h.clock.advanceMinutes(6);
    await expect(h.adminAuth.completeTotp(challenge, code())).rejects.toMatchObject({
      code: 'PC_ADMIN_CHALLENGE_INVALID',
    });
  });
});

describe('AdminAuthService TOTP challenge limits', () => {
  it('makes the challenge single-use', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ totpSecret: secret });
    const challenge = challengeOf(await captureAsyncError(login(h)));
    await h.adminAuth.completeTotp(challenge, generateTotpCode(secret, h.clock.nowMs()));
    h.clock.advanceSeconds(30);
    await expect(
      h.adminAuth.completeTotp(challenge, generateTotpCode(secret, h.clock.nowMs())),
    ).rejects.toMatchObject({ code: 'PC_ADMIN_CHALLENGE_INVALID' });
  });

  it('kills the challenge after 5 codes, even if the 6th is right', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ totpSecret: secret }, { ADMIN_LOGIN_LOCK_THRESHOLD: '50' });
    const challenge = challengeOf(await captureAsyncError(login(h)));
    const wrong = generateTotpCode(secret, h.clock.nowMs() + 10 * 60_000);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(h.adminAuth.completeTotp(challenge, wrong)).rejects.toMatchObject({
        code: 'PC_ADMIN_TOTP_INVALID',
        details: { attemptsLeft: 5 - attempt },
      });
    }
    await expect(
      h.adminAuth.completeTotp(challenge, generateTotpCode(secret, h.clock.nowMs())),
    ).rejects.toMatchObject({ code: 'PC_ADMIN_CHALLENGE_INVALID' });
    expect(h.store.state.admins.get(ADMIN_ID)?.failedLoginCount).toBe(5);
  });

  it('supersedes an older challenge with a new login', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ totpSecret: secret });
    const first = challengeOf(await captureAsyncError(login(h)));
    const second = challengeOf(await captureAsyncError(login(h)));
    const code = generateTotpCode(secret, h.clock.nowMs());
    await expect(h.adminAuth.completeTotp(first, code)).rejects.toMatchObject({
      code: 'PC_ADMIN_CHALLENGE_INVALID',
    });
    await expect(h.adminAuth.completeTotp(second, code)).resolves.toMatchObject({
      admin: { id: ADMIN_ID },
    });
  });
});

describe('AdminAuthService mandatory TOTP for owner and manager', () => {
  it.each<AdminRole>(['owner', 'manager'])(
    'requires enrollment for %s and completes the login with the first code',
    async (role) => {
      const h = withAdmin({ role });
      const error = await captureAsyncError(login(h, PASSWORD, { ip: '10.0.0.5' }));
      expect(error).toMatchObject({
        code: 'PC_ADMIN_TOTP_SETUP_REQUIRED',
        status: 403,
        details: { role, expiresAt: '2026-03-10T10:05:00.000Z' },
      });
      // A password alone gives no token and no last-login time.
      expect(h.store.state.admins.get(ADMIN_ID)?.lastLoginAt).toBeNull();

      const setup = await h.adminAuth.startTotpEnrollment(detailOf(error, 'enrollmentToken'));
      expect(setup.otpauthUri).toContain(setup.secret);
      await expect(
        h.adminAuth.confirmTotpEnrollment(
          setup.setupToken,
          generateTotpCode(setup.secret, h.clock.nowMs() + 10 * 60_000),
        ),
      ).rejects.toMatchObject({ code: 'PC_ADMIN_TOTP_INVALID' });

      const code = generateTotpCode(setup.secret, h.clock.nowMs());
      const result = await h.adminAuth.confirmTotpEnrollment(setup.setupToken, code, '10.0.0.5');
      expect(result.admin).toMatchObject({ role, totpEnabled: true });
      expect(h.tokens.verifyAccessToken(result.accessToken)).toMatchObject({ roles: [role] });
      expect(h.store.state.admins.get(ADMIN_ID)?.totpSecret).toBe(setup.secret);
      expect(h.store.audits.slice(-2)).toEqual([
        expect.objectContaining({
          action: 'admin_user.totp_enable',
          after: { totpEnabled: true, via: 'login_enrollment' },
        }),
        expect.objectContaining({ action: 'admin_user.login', after: { method: 'password+totp' } }),
      ]);

      // Enrolled: the setup token is dead and the confirmation code cannot be replayed.
      await expect(h.adminAuth.confirmTotpEnrollment(setup.setupToken, code)).rejects.toMatchObject(
        { code: 'PC_ADMIN_TOTP_ALREADY_ENABLED' },
      );
      await expect(login(h, PASSWORD, { code })).rejects.toMatchObject({
        code: 'PC_ADMIN_TOTP_INVALID',
      });
    },
  );

  it('does not hand out an enrollment token for a wrong password', async () => {
    const h = withAdmin({ role: 'owner' });
    await expect(login(h, 'wrong-password')).rejects.toMatchObject({
      code: 'PC_ADMIN_CREDENTIALS_INVALID',
    });
  });

  it('refuses tampered or outdated enrollment tokens', async () => {
    const h = withAdmin({ role: 'owner' });
    const token = detailOf(await captureAsyncError(login(h)), 'enrollmentToken');
    await expect(h.adminAuth.startTotpEnrollment(`${token}x`)).rejects.toMatchObject({
      code: 'PC_ADMIN_CHALLENGE_INVALID',
    });
    const admin = h.store.state.admins.get(ADMIN_ID);
    if (admin) {
      admin.passwordHash = await hashPassword('Another-Password-2026', TEST_PARAMS);
    }
    await expect(h.adminAuth.startTotpEnrollment(token)).rejects.toMatchObject({
      code: 'PC_ADMIN_CHALLENGE_INVALID',
    });
  });

  it('can be switched off with ADMIN_REQUIRE_TOTP_ROLES=none', async () => {
    const h = withAdmin({ role: 'owner' }, { ADMIN_REQUIRE_TOTP_ROLES: 'none' });
    await expect(login(h)).resolves.toMatchObject({ admin: { role: 'owner' } });
  });

  it('refuses to disable TOTP for a role that requires it', async () => {
    const secret = generateTotpSecret();
    const h = withAdmin({ role: 'manager', totpSecret: secret });
    await expect(
      h.adminAuth.disableTotp(ADMIN_ID, generateTotpCode(secret, h.clock.nowMs())),
    ).rejects.toMatchObject({ code: 'PC_ADMIN_TOTP_REQUIRED_FOR_ROLE', status: 409 });
    expect(h.store.state.admins.get(ADMIN_ID)?.totpSecret).toBe(secret);
  });
});

describe('AdminAuthService lockout and bursts', () => {
  it('locks the account after 5 failures with exponential backoff', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = withAdmin();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(login(h, 'wrong-password')).rejects.toMatchObject({
        code: 'PC_ADMIN_CREDENTIALS_INVALID',
      });
    }
    expect(h.store.state.admins.get(ADMIN_ID)).toMatchObject({
      failedLoginCount: 5,
      lockedUntil: new Date('2026-03-10T10:05:00.000Z'),
    });
    expect(h.store.audits.at(-1)).toMatchObject({
      actor: { type: 'system', id: 'admin-login-guard' },
      action: 'admin_user.login_locked',
      entityId: ADMIN_ID,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Admin ${ADMIN_ID} locked until`));

    // Even the right password is not checked while locked.
    await expect(login(h)).rejects.toMatchObject({
      code: 'PC_ADMIN_LOGIN_LOCKED',
      status: 429,
      details: { retryAfterSeconds: 300, lockedUntil: '2026-03-10T10:05:00.000Z' },
    });

    // After the lock another failure locks for twice as long.
    h.clock.advanceMinutes(5);
    await expect(login(h, 'wrong-password')).rejects.toMatchObject({
      code: 'PC_ADMIN_CREDENTIALS_INVALID',
    });
    expect(h.store.state.admins.get(ADMIN_ID)?.lockedUntil).toEqual(
      new Date('2026-03-10T10:15:00.000Z'),
    );

    // A successful login after the lock resets the counter.
    h.clock.advanceMinutes(10);
    await expect(login(h)).resolves.toMatchObject({ admin: { id: ADMIN_ID } });
    expect(h.store.state.admins.get(ADMIN_ID)).toMatchObject({
      failedLoginCount: 0,
      lockedUntil: null,
      lastFailedLoginAt: null,
    });
  });

  it('logs and audits a burst of failures from one network once per window', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = withAdmin({}, { ADMIN_LOGIN_BURST_THRESHOLD: '3' });
    for (let index = 0; index < 4; index += 1) {
      await captureAsyncError(
        h.adminAuth.login({
          email: `nobody-${index}@portcity.local`,
          password: 'wrong-password',
          ip: `2001:db8:5:6::${index + 1}`,
        }),
      );
    }
    const bursts = h.store.audits.filter(
      (entry) => entry.action === 'admin_user.login_failed_burst',
    );
    expect(bursts).toEqual([
      expect.objectContaining({
        actor: { type: 'system', id: 'admin-login-guard' },
        entityType: 'admin_user',
        entityId: null,
        after: { network: '2001:db8:5:6::/64', failures: 3, windowSeconds: 600 },
      }),
    ]);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('Burst of failed admin logins'),
      ),
    ).toHaveLength(1);
  });
});

describe('AdminAuthService password hashing', () => {
  it('upgrades a weaker stored hash after a successful login', async () => {
    const weak = await hashPassword(PASSWORD, scryptParamsWithLogN(8));
    const h = withAdmin({ passwordHash: weak });
    await expect(login(h, 'wrong-password')).rejects.toBeDefined();
    expect(h.store.state.admins.get(ADMIN_ID)?.passwordHash).toBe(weak);

    await login(h);
    const upgraded = h.store.state.admins.get(ADMIN_ID)?.passwordHash ?? '';
    expect(upgraded.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    // The upgraded hash still verifies the same password.
    await expect(login(h)).resolves.toMatchObject({ admin: { id: ADMIN_ID } });
    expect(h.store.state.admins.get(ADMIN_ID)?.passwordHash).toBe(upgraded);
  });

  it('answers 429 instead of queueing unbounded scrypt work', async () => {
    const h = withAdmin({}, { ADMIN_SCRYPT_MAX_CONCURRENT: '1', ADMIN_SCRYPT_MAX_QUEUE: '0' });
    const results = await Promise.allSettled([login(h), login(h), login(h)]);
    const busy = results.filter(
      (result) =>
        result.status === 'rejected' &&
        (result.reason as { code?: string }).code === 'PC_ADMIN_LOGIN_BUSY',
    );
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const refused = busy[0];
    expect(refused?.status === 'rejected' ? refused.reason : null).toMatchObject({
      status: 429,
      details: { retryAfterSeconds: 1 },
    });
  });
});

describe('AdminAuthService TOTP management', () => {
  it('enables TOTP with setup and confirm, then disables it with a code', async () => {
    const h = withAdmin();
    const setup = await h.adminAuth.setupTotp(ADMIN_ID);
    expect(setup.otpauthUri).toContain('otpauth://totp/');
    expect(setup.otpauthUri).toContain(setup.secret);
    expect(setup.expiresAt).toBe('2026-03-10T10:10:00.000Z');

    const wrong = generateTotpCode(setup.secret, h.clock.nowMs() + 10 * 60_000);
    await expect(h.adminAuth.confirmTotp(ADMIN_ID, setup.setupToken, wrong)).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_INVALID',
    });
    const enabled = await h.adminAuth.confirmTotp(
      ADMIN_ID,
      setup.setupToken,
      generateTotpCode(setup.secret, h.clock.nowMs()),
      '10.0.0.2',
    );
    expect(enabled.totpEnabled).toBe(true);
    expect(h.store.state.admins.get(ADMIN_ID)?.totpSecret).toBe(setup.secret);
    expect(h.store.audits.at(-1)).toMatchObject({ action: 'admin_user.totp_enable' });

    await expect(h.adminAuth.setupTotp(ADMIN_ID)).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_ALREADY_ENABLED',
    });

    h.clock.advanceMinutes(2);
    const disabled = await h.adminAuth.disableTotp(
      ADMIN_ID,
      generateTotpCode(setup.secret, h.clock.nowMs()),
    );
    expect(disabled.totpEnabled).toBe(false);
    await expect(h.adminAuth.disableTotp(ADMIN_ID, '123456')).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_NOT_ENABLED',
    });
  });

  it('spends the confirm code and refuses to disable TOTP with a code already used', async () => {
    const h = withAdmin();
    const setup = await h.adminAuth.setupTotp(ADMIN_ID);
    const confirmCode = generateTotpCode(setup.secret, h.clock.nowMs());
    await h.adminAuth.confirmTotp(ADMIN_ID, setup.setupToken, confirmCode);
    expect(h.store.state.admins.get(ADMIN_ID)?.totpLastStep).toBe(
      Math.floor(h.clock.nowMs() / 30_000),
    );
    await expect(login(h, PASSWORD, { code: confirmCode })).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_INVALID',
    });

    h.clock.advanceSeconds(30);
    const loginCode = generateTotpCode(setup.secret, h.clock.nowMs());
    await login(h, PASSWORD, { code: loginCode });
    await expect(h.adminAuth.disableTotp(ADMIN_ID, loginCode)).rejects.toMatchObject({
      code: 'PC_ADMIN_TOTP_INVALID',
    });
    expect(h.store.state.admins.get(ADMIN_ID)?.totpSecret).toBe(setup.secret);

    h.clock.advanceSeconds(30);
    await h.adminAuth.disableTotp(ADMIN_ID, generateTotpCode(setup.secret, h.clock.nowMs()));
    expect(h.store.state.admins.get(ADMIN_ID)).toMatchObject({
      totpSecret: null,
      totpLastStep: null,
    });
  });

  it('refuses a setup token of another admin or an expired one', async () => {
    const h = withAdmin();
    h.store.seedAdmin({
      id: 'admin-2',
      email: 'second@portcity.local',
      passwordHash,
      role: 'manager',
    });
    const setup = await h.adminAuth.setupTotp('admin-2');
    const code = generateTotpCode(setup.secret, h.clock.nowMs());
    await expect(h.adminAuth.confirmTotp(ADMIN_ID, setup.setupToken, code)).rejects.toMatchObject({
      code: 'PC_ADMIN_CHALLENGE_INVALID',
    });
    h.clock.advanceMinutes(11);
    await expect(
      h.adminAuth.confirmTotp(
        'admin-2',
        setup.setupToken,
        generateTotpCode(setup.secret, h.clock.nowMs()),
      ),
    ).rejects.toMatchObject({ code: 'PC_ADMIN_CHALLENGE_INVALID' });
  });

  it('reports missing and deactivated admins', async () => {
    const h = withAdmin({ active: false });
    await expect(h.adminAuth.getMe('missing')).rejects.toMatchObject({
      code: 'PC_ADMIN_NOT_FOUND',
    });
    await expect(h.adminAuth.getMe(ADMIN_ID)).rejects.toMatchObject({ code: 'PC_ADMIN_INACTIVE' });
  });
});
