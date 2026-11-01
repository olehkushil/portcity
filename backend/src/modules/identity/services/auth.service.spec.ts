import { Logger } from '@nestjs/common';
import { hasValidCheckDigit } from '../domain/member-code';
import {
  ANDROID_DEVICE,
  TEST_IP,
  TEST_PHONE,
  captureAsyncError,
  createIdentityHarness,
  loginMember,
} from '../testing/fixtures';
import type { IdentityUow } from './identity.store';
import { StoreConflictError } from './identity.store';

describe('AuthService.requestOtp', () => {
  it('normalises the phone, sends a 6-digit code by SMS and stores only its HMAC', async () => {
    const h = createIdentityHarness();
    const result = await h.auth.requestOtp({ phone: '050 123 45 67', ip: TEST_IP });

    expect(result).toEqual({
      phone: TEST_PHONE,
      expiresAt: '2026-03-10T10:05:00.000Z',
      // The harness runs without the resend cooldown; see the cooldown test below.
      resendAvailableAt: '2026-03-10T10:00:00.000Z',
      codeLength: 6,
      maxAttempts: 5,
    });
    const code = h.sms.lastCode(TEST_PHONE);
    expect(code).toMatch(/^\d{6}$/);
    const [challenge] = [...h.store.state.otpChallenges.values()];
    expect(challenge).toMatchObject({
      phone: TEST_PHONE,
      ip: TEST_IP,
      attempts: 0,
      maxAttempts: 5,
    });
    expect(challenge?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge?.codeHash).not.toContain(code);
  });

  it('echoes the code only when OTP_DEV_ECHO is on', async () => {
    const h = createIdentityHarness({ identity: { OTP_DEV_ECHO: 'true' } });
    const result = await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    expect(result.debugCode).toBe(h.sms.lastCode(TEST_PHONE));
  });

  it('rejects an invalid phone', async () => {
    const h = createIdentityHarness();
    await expect(h.auth.requestOtp({ phone: '12345', ip: TEST_IP })).rejects.toMatchObject({
      code: 'PC_COMMON_PHONE_INVALID',
    });
  });

  it('allows 3 codes per phone per 10 minutes', async () => {
    const h = createIdentityHarness();
    for (let index = 0; index < 3; index += 1) {
      await h.auth.requestOtp({ phone: TEST_PHONE, ip: `198.51.100.${index}` });
    }
    const error = await captureAsyncError(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP }));
    expect(error).toMatchObject({
      code: 'PC_OTP_RATE_LIMITED',
      status: 429,
      details: { scope: 'phone', retryAfterSeconds: 600 },
    });

    h.clock.advanceMinutes(10);
    await expect(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })).resolves.toBeDefined();
  });

  it('allows 10 codes per IP per hour', async () => {
    const h = createIdentityHarness();
    for (let index = 0; index < 10; index += 1) {
      await h.auth.requestOtp({ phone: `+38050100000${index}`, ip: TEST_IP });
    }
    const error = await captureAsyncError(
      h.auth.requestOtp({ phone: '+380671234567', ip: TEST_IP }),
    );
    expect(error).toMatchObject({ code: 'PC_OTP_RATE_LIMITED', details: { scope: 'ip' } });
    await expect(
      h.auth.requestOtp({ phone: '+380671234567', ip: '198.51.100.99' }),
    ).resolves.toBeDefined();
  });

  it('does not send an SMS for a static demo code and accepts that code', async () => {
    const h = createIdentityHarness({ identity: { OTP_STATIC_CODES: '+380501234567:111222' } });
    const result = await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    expect(result.codeLength).toBe(6);
    expect(h.sms.sent).toHaveLength(0);
    const login = await h.auth.verifyOtp({
      phone: TEST_PHONE,
      code: '111222',
      device: ANDROID_DEVICE,
    });
    expect(login.isNewUser).toBe(true);
  });

  it('surfaces gateway failures as PC_OTP_DELIVERY_FAILED', async () => {
    const h = createIdentityHarness();
    h.sms.failNext();
    await expect(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })).rejects.toMatchObject({
      code: 'PC_OTP_DELIVERY_FAILED',
      status: 503,
    });
  });

  it('stores the installation fingerprint and works without an IP', async () => {
    const h = createIdentityHarness();
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: null, fingerprint: ' install-0001 ' });
    expect([...h.store.state.otpChallenges.values()][0]).toMatchObject({
      ip: null,
      deviceFingerprint: 'install-0001',
    });
  });
});

describe('AuthService.requestOtp abuse protection', () => {
  it('enforces the resend cooldown and returns resendAvailableAt for the countdown', async () => {
    const h = createIdentityHarness({ identity: { OTP_RESEND_COOLDOWN_SECONDS: '60' } });
    const first = await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    expect(first.resendAvailableAt).toBe('2026-03-10T10:01:00.000Z');

    h.clock.advanceSeconds(20);
    expect(
      await captureAsyncError(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })),
    ).toMatchObject({
      code: 'PC_OTP_RATE_LIMITED',
      status: 429,
      details: { scope: 'cooldown', retryAfterSeconds: 40, retryAt: '2026-03-10T10:01:00.000Z' },
    });

    h.clock.advanceSeconds(40);
    const second = await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    expect(second.resendAvailableAt).toBe('2026-03-10T10:02:00.000Z');
    h.clock.advanceSeconds(60);
    // Third code of the 10-minute window: the next is possible when the first leaves the window.
    const third = await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    expect(third.resendAvailableAt).toBe('2026-03-10T10:10:00.000Z');
  });

  it('caps codes per phone per 24 hours', async () => {
    const h = createIdentityHarness();
    for (let index = 0; index < 5; index += 1) {
      await h.auth.requestOtp({ phone: TEST_PHONE, ip: `198.51.100.${index}` });
      h.clock.advanceMinutes(11);
    }
    expect(
      await captureAsyncError(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })),
    ).toMatchObject({ code: 'PC_OTP_RATE_LIMITED', details: { scope: 'phone_daily' } });
    h.clock.advanceHours(24);
    await expect(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })).resolves.toBeDefined();
  });

  it('counts IPv6 clients per /64 and stores the network as the IP key', async () => {
    const h = createIdentityHarness({ identity: { OTP_IP_LIMIT: '2' } });
    await h.auth.requestOtp({ phone: '+380501000001', ip: '2001:db8:1:2::a' });
    await h.auth.requestOtp({ phone: '+380501000002', ip: '2001:db8:1:2:ffff::b' });
    expect(
      await captureAsyncError(h.auth.requestOtp({ phone: '+380501000003', ip: '2001:db8:1:2::c' })),
    ).toMatchObject({ code: 'PC_OTP_RATE_LIMITED', details: { scope: 'ip' } });
    await expect(
      h.auth.requestOtp({ phone: '+380501000003', ip: '2001:db8:1:3::c' }),
    ).resolves.toBeDefined();
    await h.auth.requestOtp({ phone: '+380501000004', ip: '::ffff:203.0.113.9' });
    expect([...h.store.state.otpChallenges.values()].map((row) => row.ip)).toEqual([
      '2001:db8:1:2::/64',
      '2001:db8:1:2::/64',
      '2001:db8:1:3::/64',
      '203.0.113.9',
    ]);
  });

  it('keeps the count-then-insert atomic under parallel requests', async () => {
    const h = createIdentityHarness();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        h.auth.requestOtp({ phone: TEST_PHONE, ip: `198.51.100.${index}` }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(h.store.state.otpChallenges.size).toBe(3);
    expect(h.sms.sent).toHaveLength(3);
  });

  it('stops sending at the global daily SMS budget and warns at 80 %', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = createIdentityHarness({
      identity: { SMS_DAILY_BUDGET: '5', OTP_STATIC_CODES: '+380671112233:111222' },
    });
    for (let index = 0; index < 4; index += 1) {
      await h.auth.requestOtp({ phone: `+38050100000${index}`, ip: `198.51.100.${index}` });
    }
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('SMS daily budget')),
    ).toHaveLength(1);
    await h.auth.requestOtp({ phone: '+380501000009', ip: '198.51.100.9' });
    expect(
      await captureAsyncError(h.auth.requestOtp({ phone: '+380501000008', ip: '198.51.100.8' })),
    ).toMatchObject({ code: 'PC_OTP_SMS_BUDGET_EXHAUSTED', status: 503 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SMS daily budget exhausted'));
    expect(h.sms.sent).toHaveLength(5);
    // Demo numbers send no SMS and are not stopped by the budget.
    await expect(
      h.auth.requestOtp({ phone: '+380671112233', ip: '198.51.100.7' }),
    ).resolves.toBeDefined();
    // The next Kyiv day has a fresh budget (2026-03-10 10:00 UTC = 12:00 Kyiv).
    h.clock.advanceHours(12);
    await expect(
      h.auth.requestOtp({ phone: '+380501000008', ip: '198.51.100.8' }),
    ).resolves.toBeDefined();
  });

  it('asks the captcha hook above the soft thresholds only', async () => {
    const h = createIdentityHarness({
      identity: { OTP_CAPTCHA_PHONE_THRESHOLD: '2', OTP_CAPTCHA_IP_THRESHOLD: '3' },
    });
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    h.clock.advanceMinutes(11);
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    expect(h.captcha.checks).toHaveLength(0);

    h.clock.advanceMinutes(11);
    h.captcha.answer = false;
    expect(
      await captureAsyncError(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })),
    ).toMatchObject({
      code: 'PC_OTP_CAPTCHA_REQUIRED',
      status: 403,
      details: { reason: 'missing' },
    });
    expect(h.captcha.checks.at(-1)).toEqual({
      token: null,
      action: 'otp_request',
      ip: TEST_IP,
      phone: TEST_PHONE,
    });
    h.captcha.answer = true;
    expect(
      await captureAsyncError(
        h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP, captchaToken: 'bad-token' }),
      ),
    ).toMatchObject({ code: 'PC_OTP_CAPTCHA_REQUIRED', details: { reason: 'invalid' } });
    await expect(
      h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP, captchaToken: 'good-token' }),
    ).resolves.toBeDefined();
    expect(h.store.state.otpChallenges.size).toBe(3);
  });
});

describe('AuthService wrong-code lock per phone', () => {
  async function burnChallenge(h: ReturnType<typeof createIdentityHarness>): Promise<void> {
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    const good = h.sms.lastCode(TEST_PHONE);
    const bad = good === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await captureAsyncError(
        h.auth.verifyOtp({ phone: TEST_PHONE, code: bad, device: ANDROID_DEVICE }),
      );
    }
  }

  it('locks verification and new codes after 10 wrong codes in 24 hours', async () => {
    const h = createIdentityHarness();
    await burnChallenge(h);
    h.clock.advanceMinutes(30);
    await burnChallenge(h);

    h.clock.advanceMinutes(1);
    expect(
      await captureAsyncError(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })),
    ).toMatchObject({
      code: 'PC_OTP_LOCKED',
      status: 429,
      details: { lockedUntil: '2026-03-11T10:00:00.000Z' },
    });
    expect(
      await captureAsyncError(
        h.auth.verifyOtp({ phone: TEST_PHONE, code: '123456', device: ANDROID_DEVICE }),
      ),
    ).toMatchObject({ code: 'PC_OTP_LOCKED' });

    // The first challenge (5 failures) leaves the window 24 h after it was created.
    h.clock.set('2026-03-11T10:00:01.000Z');
    await expect(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })).resolves.toBeDefined();
    await expect(
      h.auth.verifyOtp({
        phone: TEST_PHONE,
        code: h.sms.lastCode(TEST_PHONE),
        device: ANDROID_DEVICE,
      }),
    ).resolves.toMatchObject({ isNewUser: true });
  });

  it('does not count the successful attempt as a failure', async () => {
    const h = createIdentityHarness({ identity: { OTP_VERIFY_FAILURE_LIMIT: '2' } });
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    const good = h.sms.lastCode(TEST_PHONE);
    await captureAsyncError(
      h.auth.verifyOtp({
        phone: TEST_PHONE,
        code: good === '000000' ? '111111' : '000000',
        device: ANDROID_DEVICE,
      }),
    );
    await expect(
      h.auth.verifyOtp({ phone: TEST_PHONE, code: good, device: ANDROID_DEVICE }),
    ).resolves.toMatchObject({ isNewUser: true });
    await expect(h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP })).resolves.toBeDefined();
  });
});

describe('AuthService.verifyOtp', () => {
  it('registers a new member, binds the device and issues tokens', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);

    expect(login.isNewUser).toBe(true);
    expect(login.tokenType).toBe('Bearer');
    expect(login.user.phone).toBe(TEST_PHONE);
    expect(login.user.status).toBe('active');
    expect(hasValidCheckDigit(login.user.memberCode)).toBe(true);
    expect(login.accessTokenExpiresAt).toBe('2026-03-10T10:15:00.000Z');
    expect(login.refreshTokenExpiresAt).toBe('2026-05-09T10:00:00.000Z');

    const claims = h.tokens.verifyAccessToken(login.accessToken);
    expect(claims).toMatchObject({ sub: login.user.id, typ: 'member', did: login.deviceId });

    const device = h.store.state.devices.get(login.deviceId);
    expect(device).toMatchObject({
      userId: login.user.id,
      platform: 'android',
      model: 'Pixel 8',
      fingerprint: ANDROID_DEVICE.fingerprint,
    });
    const [token] = [...h.store.state.refreshTokens.values()];
    expect(token?.tokenHash).toBe(h.tokens.hashRefreshToken(login.refreshToken));
    expect(token?.deviceId).toBe(login.deviceId);

    expect(h.store.eventTypes()).toEqual(['user.device_registered', 'user.registered']);
    expect(h.store.events[1]?.payload).toEqual({
      userId: login.user.id,
      memberCode: login.user.memberCode,
      deviceId: login.deviceId,
      registeredAt: '2026-03-10T10:00:00.000Z',
    });
    expect([...h.store.state.otpChallenges.values()][0]?.consumedAt).not.toBeNull();
  });

  it('counts wrong codes and burns the challenge after 5 attempts', async () => {
    const h = createIdentityHarness();
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    const good = h.sms.lastCode(TEST_PHONE);
    const bad = good === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const error = await captureAsyncError(
        h.auth.verifyOtp({ phone: TEST_PHONE, code: bad, device: ANDROID_DEVICE }),
      );
      expect(error).toMatchObject({
        code: 'PC_OTP_INVALID',
        details: { attemptsLeft: 5 - attempt },
      });
    }
    await expect(
      h.auth.verifyOtp({ phone: TEST_PHONE, code: bad, device: ANDROID_DEVICE }),
    ).rejects.toMatchObject({ code: 'PC_OTP_TOO_MANY_ATTEMPTS', status: 429 });
    await expect(
      h.auth.verifyOtp({ phone: TEST_PHONE, code: good, device: ANDROID_DEVICE }),
    ).rejects.toMatchObject({ code: 'PC_OTP_TOO_MANY_ATTEMPTS' });
    expect([...h.store.state.otpChallenges.values()][0]?.attempts).toBe(5);
    expect(h.store.state.users.size).toBe(0);
  });

  it('does not give parallel guesses more than 5 tries at one code', async () => {
    const h = createIdentityHarness();
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    const good = h.sms.lastCode(TEST_PHONE);
    const bad = good === '000000' ? '111111' : '000000';

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        captureAsyncError(
          h.auth.verifyOtp({ phone: TEST_PHONE, code: bad, device: ANDROID_DEVICE }),
        ),
      ),
    );
    const codes = results.map((error) => (error as { code: string }).code);
    expect(codes.filter((code) => code === 'PC_OTP_INVALID')).toHaveLength(4);
    expect(codes.filter((code) => code === 'PC_OTP_TOO_MANY_ATTEMPTS')).toHaveLength(4);
    expect([...h.store.state.otpChallenges.values()][0]?.attempts).toBe(5);
    await expect(
      h.auth.verifyOtp({ phone: TEST_PHONE, code: good, device: ANDROID_DEVICE }),
    ).rejects.toMatchObject({ code: 'PC_OTP_TOO_MANY_ATTEMPTS' });
  });

  it('rejects an expired code', async () => {
    const h = createIdentityHarness();
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    h.clock.advanceMinutes(5);
    await expect(
      h.auth.verifyOtp({
        phone: TEST_PHONE,
        code: h.sms.lastCode(TEST_PHONE),
        device: ANDROID_DEVICE,
      }),
    ).rejects.toMatchObject({ code: 'PC_OTP_EXPIRED', status: 401 });
  });

  it('rejects a code that was already used and a phone without a challenge', async () => {
    const h = createIdentityHarness();
    await loginMember(h);
    await expect(
      h.auth.verifyOtp({
        phone: TEST_PHONE,
        code: h.sms.lastCode(TEST_PHONE),
        device: ANDROID_DEVICE,
      }),
    ).rejects.toMatchObject({ code: 'PC_OTP_INVALID' });
    await expect(
      h.auth.verifyOtp({ phone: '+380671234567', code: '123456', device: ANDROID_DEVICE }),
    ).rejects.toMatchObject({ code: 'PC_OTP_INVALID' });
  });

  it('voids the previous code when a new one is requested', async () => {
    const h = createIdentityHarness();
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    const first = h.sms.lastCode(TEST_PHONE);
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    const second = h.sms.lastCode(TEST_PHONE);
    if (first !== second) {
      await expect(
        h.auth.verifyOtp({ phone: TEST_PHONE, code: first, device: ANDROID_DEVICE }),
      ).rejects.toMatchObject({ code: 'PC_OTP_INVALID' });
    }
    await expect(
      h.auth.verifyOtp({ phone: TEST_PHONE, code: second, device: ANDROID_DEVICE }),
    ).resolves.toMatchObject({ isNewUser: true });
  });

  it('logs an existing member in on the same device row and ends its older sessions', async () => {
    const h = createIdentityHarness();
    const first = await loginMember(h);
    h.clock.advanceMinutes(30);
    const second = await loginMember(h);

    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.deviceId).toBe(first.deviceId);
    expect(h.store.eventTypes().filter((type) => type === 'user.registered')).toHaveLength(1);
    await expect(h.sessions.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
    await expect(h.sessions.refresh(second.refreshToken)).resolves.toBeDefined();
  });

  it('refuses blocked members and leaves the code unconsumed', async () => {
    const h = createIdentityHarness();
    h.store.seedUser({
      id: 'u-blocked',
      phone: TEST_PHONE,
      memberCode: '734211800',
      status: 'blocked',
    });
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    await expect(
      h.auth.verifyOtp({
        phone: TEST_PHONE,
        code: h.sms.lastCode(TEST_PHONE),
        device: ANDROID_DEVICE,
      }),
    ).rejects.toMatchObject({ code: 'PC_USER_BLOCKED', status: 403 });
    expect([...h.store.state.otpChallenges.values()][0]?.consumedAt).toBeNull();
    expect(h.store.state.refreshTokens.size).toBe(0);
  });

  it('applies consents sent with the login in the same transaction', async () => {
    const h = createIdentityHarness();
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    const login = await h.auth.verifyOtp({
      phone: TEST_PHONE,
      code: h.sms.lastCode(TEST_PHONE),
      device: ANDROID_DEVICE,
      consents: [{ purpose: 'program', granted: true, version: '2026-10' }],
    });
    await expect(h.port.hasConsent(login.user.id, 'program')).resolves.toBe(true);
    await expect(h.port.hasConsent(login.user.id, 'marketing')).resolves.toBe(false);
  });

  it('accepts the current legal version when a consent is granted without one', async () => {
    const h = createIdentityHarness({ identity: { LEGAL_PROGRAM_VERSION: '2026-11' } });
    await h.auth.requestOtp({ phone: TEST_PHONE, ip: TEST_IP });
    await h.auth.verifyOtp({
      phone: TEST_PHONE,
      code: h.sms.lastCode(TEST_PHONE),
      device: ANDROID_DEVICE,
      consents: [{ purpose: 'program', granted: true }],
    });
    expect([...h.store.state.consents.values()]).toEqual([
      expect.objectContaining({ purpose: 'program', version: '2026-11', revokedAt: null }),
    ]);
  });

  it('retries the login transaction when the member code collides', async () => {
    const h = createIdentityHarness();
    const originalRun = h.store.run.bind(h.store);
    let collisions = 0;
    jest.spyOn(h.store, 'run').mockImplementation(<T>(fn: (uow: IdentityUow) => Promise<T>) =>
      originalRun((uow) => {
        if (collisions > 0) {
          return fn(uow);
        }
        const failing = new Proxy(uow, {
          get(target, property, receiver) {
            if (property === 'createUser') {
              return async () => {
                collisions += 1;
                throw new StoreConflictError('user', ['member_code']);
              };
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(failing);
      }),
    );

    const login = await loginMember(h);
    expect(collisions).toBe(1);
    expect(login.isNewUser).toBe(true);
    expect(h.store.state.users.size).toBe(1);
  });
});
