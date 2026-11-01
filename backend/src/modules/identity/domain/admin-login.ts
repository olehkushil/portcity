/**
 * Back-office login decision table (brief section 3: email + scrypt password + TOTP).
 * The password is always checked before the account state so that a probe cannot tell an
 * unknown email from a deactivated one; `passwordValid` is false when the admin is unknown.
 * A lock (too many failures) is checked by the service before the password is even verified.
 */
export interface AdminLoginFacts {
  adminFound: boolean;
  passwordValid: boolean;
  active: boolean;
  totpEnabled: boolean;
  /** The admin's role is listed in ADMIN_REQUIRE_TOTP_ROLES. */
  totpRequiredForRole: boolean;
  codeProvided: boolean;
  codeValid: boolean;
}

export type AdminLoginOutcome =
  | 'invalid_credentials'
  | 'inactive'
  | 'totp_setup_required'
  | 'totp_required'
  | 'totp_invalid'
  | 'ok';

export function decideAdminLogin(facts: AdminLoginFacts): AdminLoginOutcome {
  if (!facts.adminFound || !facts.passwordValid) {
    return 'invalid_credentials';
  }
  if (!facts.active) {
    return 'inactive';
  }
  if (facts.totpEnabled) {
    if (!facts.codeProvided) {
      return 'totp_required';
    }
    if (!facts.codeValid) {
      return 'totp_invalid';
    }
    return 'ok';
  }
  return facts.totpRequiredForRole ? 'totp_setup_required' : 'ok';
}

export interface AdminLockPolicy {
  /** Failures that trigger the first lock. */
  threshold: number;
  baseSeconds: number;
  maxSeconds: number;
  /** A failure older than this restarts the count. */
  windowSeconds: number;
}

export interface AdminFailureState {
  failedLoginCount: number;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
}

export interface AdminFailureUpdate extends AdminFailureState {
  lastFailedLoginAt: Date;
  /** True when this failure (re)locked the account. */
  lockedNow: boolean;
}

export function isAdminLocked(state: Pick<AdminFailureState, 'lockedUntil'>, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Lock duration after `count` consecutive failures: base, doubled per failure, capped. */
export function adminLockSeconds(count: number, policy: AdminLockPolicy): number {
  if (count < policy.threshold) {
    return 0;
  }
  const doublings = Math.min(count - policy.threshold, 30);
  return Math.min(policy.baseSeconds * 2 ** doublings, policy.maxSeconds);
}

/**
 * Next counter state after a failed login (wrong password, wrong or replayed TOTP code). From the
 * threshold on, every failure locks the account with exponential backoff:
 * threshold -> base, +1 -> 2 x base, ... up to max.
 */
export function registerAdminLoginFailure(
  state: AdminFailureState,
  now: Date,
  policy: AdminLockPolicy,
): AdminFailureUpdate {
  const recent =
    state.lastFailedLoginAt !== null &&
    now.getTime() - state.lastFailedLoginAt.getTime() <= policy.windowSeconds * 1000;
  const failedLoginCount = recent ? state.failedLoginCount + 1 : 1;
  const seconds = adminLockSeconds(failedLoginCount, policy);
  return {
    failedLoginCount,
    lastFailedLoginAt: now,
    lockedUntil: seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null,
    lockedNow: seconds > 0,
  };
}
