import {
  type AdminFailureState,
  type AdminLockPolicy,
  type AdminLoginFacts,
  type AdminLoginOutcome,
  adminLockSeconds,
  decideAdminLogin,
  isAdminLocked,
  registerAdminLoginFailure,
} from './admin-login';

describe('decideAdminLogin', () => {
  const ok: AdminLoginFacts = {
    adminFound: true,
    passwordValid: true,
    active: true,
    totpEnabled: false,
    totpRequiredForRole: false,
    codeProvided: false,
    codeValid: false,
  };

  it.each<[string, Partial<AdminLoginFacts>, AdminLoginOutcome]>([
    ['unknown email', { adminFound: false, passwordValid: false }, 'invalid_credentials'],
    [
      'unknown email with valid-looking password flag',
      { adminFound: false },
      'invalid_credentials',
    ],
    ['wrong password', { passwordValid: false }, 'invalid_credentials'],
    [
      'wrong password on inactive account hides the state',
      { passwordValid: false, active: false },
      'invalid_credentials',
    ],
    [
      'wrong password on a role that needs TOTP hides the setup state',
      { passwordValid: false, totpRequiredForRole: true },
      'invalid_credentials',
    ],
    ['inactive', { active: false }, 'inactive'],
    ['password only, no TOTP configured, role without requirement', {}, 'ok'],
    [
      'password only, no TOTP configured, role requires TOTP',
      { totpRequiredForRole: true },
      'totp_setup_required',
    ],
    [
      'role requires TOTP, a code sent without TOTP configured',
      { totpRequiredForRole: true, codeProvided: true },
      'totp_setup_required',
    ],
    ['TOTP configured, no code', { totpEnabled: true }, 'totp_required'],
    [
      'TOTP configured, wrong code',
      { totpEnabled: true, codeProvided: true, codeValid: false },
      'totp_invalid',
    ],
    [
      'TOTP configured, right code',
      { totpEnabled: true, codeProvided: true, codeValid: true },
      'ok',
    ],
    [
      'TOTP configured on a role that requires it, right code',
      { totpEnabled: true, totpRequiredForRole: true, codeProvided: true, codeValid: true },
      'ok',
    ],
    [
      'inactive with TOTP',
      { active: false, totpEnabled: true, codeProvided: true, codeValid: true },
      'inactive',
    ],
  ])('%s -> %s', (_name, overrides, expected) => {
    expect(decideAdminLogin({ ...ok, ...overrides })).toBe(expected);
  });
});

describe('admin login lockout', () => {
  const policy: AdminLockPolicy = {
    threshold: 5,
    baseSeconds: 300,
    maxSeconds: 3600,
    windowSeconds: 86_400,
  };
  const now = new Date('2026-03-10T10:00:00.000Z');
  const fresh: AdminFailureState = {
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
  };

  it.each([
    [1, 0],
    [4, 0],
    [5, 300],
    [6, 600],
    [7, 1200],
    [8, 2400],
    [9, 3600],
    [50, 3600],
  ])('locks for the backoff after %i failures: %i s', (count, seconds) => {
    expect(adminLockSeconds(count, policy)).toBe(seconds);
  });

  it('counts consecutive failures and locks from the threshold on', () => {
    let state: AdminFailureState = fresh;
    for (let index = 1; index <= 4; index += 1) {
      const next = registerAdminLoginFailure(state, now, policy);
      expect(next).toMatchObject({ failedLoginCount: index, lockedUntil: null, lockedNow: false });
      state = next;
    }
    const fifth = registerAdminLoginFailure(state, now, policy);
    expect(fifth).toMatchObject({
      failedLoginCount: 5,
      lockedNow: true,
      lockedUntil: new Date('2026-03-10T10:05:00.000Z'),
    });
    expect(isAdminLocked(fifth, now)).toBe(true);
    expect(isAdminLocked(fifth, new Date('2026-03-10T10:05:00.000Z'))).toBe(false);
  });

  it('restarts the count when the previous failure left the window', () => {
    const old: AdminFailureState = {
      failedLoginCount: 4,
      lastFailedLoginAt: new Date('2026-03-09T09:59:59.000Z'),
      lockedUntil: null,
    };
    expect(registerAdminLoginFailure(old, now, policy)).toMatchObject({
      failedLoginCount: 1,
      lockedNow: false,
    });
  });

  it('is not locked without a lock time', () => {
    expect(isAdminLocked(fresh, now)).toBe(false);
  });
});
