import { hmacSha256Hex } from '../../../common/auth/crypto';

/** Accepted code shape (length is configured; 6 digits by default). */
export const OTP_CODE_PATTERN = /^\d{4,8}$/;

const SECOND_MS = 1000;
export const DAY_SECONDS = 86_400;

export interface OtpWindowLimit {
  limit: number;
  windowSeconds: number;
}

/**
 * Request policy for `POST /auth/otp/request` (brief section 8 plus the abuse review):
 * cooldown between codes, 3 per phone per 10 minutes, 5 per phone per 24 hours, 10 per IP
 * network per hour, and a lock after 10 wrong codes per phone in 24 hours.
 */
export interface OtpRequestPolicy {
  cooldownSeconds: number;
  perPhone: OtpWindowLimit;
  perPhoneDaily: OtpWindowLimit;
  perIp: OtpWindowLimit;
  failures: OtpWindowLimit;
}

/** What the store reports about recent challenges of one phone (any state). */
export interface OtpPhoneHistoryRow {
  createdAt: Date;
  attempts: number;
  consumedAt: Date | null;
}

export type OtpRequestRefusal = 'locked' | 'cooldown' | 'phone' | 'phone_daily' | 'ip';

export type OtpRequestDecision =
  | {
      allowed: true;
      /** When the app may offer "send again" after this request (countdown on the screen). */
      resendAvailableAt: Date;
      /** Counts before this request (soft captcha thresholds). */
      phoneDailyCount: number;
      ipCount: number;
    }
  | { allowed: false; reason: OtpRequestRefusal; retryAfterSeconds: number; until: Date };

export interface OtpFailureState {
  failures: number;
  locked: boolean;
  /** When enough failures leave the window for the phone to be unlocked (null when not locked). */
  lockedUntil: Date | null;
}

const ms = (seconds: number): number => seconds * SECOND_MS;

function secondsUntil(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / SECOND_MS));
}

function within(times: readonly Date[], now: Date, windowSeconds: number): Date[] {
  const from = now.getTime() - ms(windowSeconds);
  return times
    .filter((time) => time.getTime() > from && time.getTime() <= now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Moment when the window count drops below `limit` again, given the times inside the window
 * (ascending): the (count - limit + 1)-th oldest entry has to leave the window.
 */
function windowFreesAt(times: readonly Date[], limit: number, windowSeconds: number): Date | null {
  if (times.length < limit) {
    return null;
  }
  const index = times.length - limit;
  const pivot = times[index];
  return pivot ? new Date(pivot.getTime() + ms(windowSeconds)) : null;
}

/** Wrong codes of one challenge: every counted attempt except the one that succeeded. */
export function challengeFailures(row: OtpPhoneHistoryRow): number {
  return Math.max(0, row.attempts - (row.consumedAt ? 1 : 0));
}

/**
 * Wrong codes for the phone over the failure window (all challenges together). Reaching the limit
 * locks the phone (no verification, no new codes) until enough failures leave the window.
 */
export function evaluateOtpFailures(
  rows: readonly OtpPhoneHistoryRow[],
  now: Date,
  policy: OtpWindowLimit,
): OtpFailureState {
  const from = now.getTime() - ms(policy.windowSeconds);
  const relevant = rows
    .filter((row) => row.createdAt.getTime() > from && challengeFailures(row) > 0)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const failures = relevant.reduce((sum, row) => sum + challengeFailures(row), 0);
  if (failures < policy.limit) {
    return { failures, locked: false, lockedUntil: null };
  }
  let remaining = failures;
  for (const row of relevant) {
    remaining -= challengeFailures(row);
    if (remaining < policy.limit) {
      return {
        failures,
        locked: true,
        lockedUntil: new Date(row.createdAt.getTime() + ms(policy.windowSeconds)),
      };
    }
  }
  return {
    failures,
    locked: true,
    lockedUntil: new Date(now.getTime() + ms(policy.windowSeconds)),
  };
}

/**
 * Decides an OTP request from the phone history and the IP-network request times (both read
 * inside the transaction that holds the per-phone advisory lock, so the decision and the insert
 * are atomic per phone). Checks, in order: failure lock, cooldown, 10-minute phone window, daily
 * phone cap, IP window. On success returns when the next code may be requested.
 */
export function decideOtpRequest(input: {
  phone: readonly OtpPhoneHistoryRow[];
  ipTimes: readonly Date[];
  now: Date;
  policy: OtpRequestPolicy;
}): OtpRequestDecision {
  const { now, policy } = input;
  const refuse = (reason: OtpRequestRefusal, until: Date): OtpRequestDecision => ({
    allowed: false,
    reason,
    until,
    retryAfterSeconds: secondsUntil(until, now),
  });

  const lock = evaluateOtpFailures(input.phone, now, policy.failures);
  if (lock.locked && lock.lockedUntil) {
    return refuse('locked', lock.lockedUntil);
  }

  const phoneTimes = input.phone.map((row) => row.createdAt);
  const last = within(phoneTimes, now, Math.max(policy.cooldownSeconds, 1)).at(-1);
  if (policy.cooldownSeconds > 0 && last) {
    return refuse('cooldown', new Date(last.getTime() + ms(policy.cooldownSeconds)));
  }
  const windowTimes = within(phoneTimes, now, policy.perPhone.windowSeconds);
  const windowFree = windowFreesAt(
    windowTimes,
    policy.perPhone.limit,
    policy.perPhone.windowSeconds,
  );
  if (windowFree) {
    return refuse('phone', windowFree);
  }
  const dailyTimes = within(phoneTimes, now, policy.perPhoneDaily.windowSeconds);
  const dailyFree = windowFreesAt(
    dailyTimes,
    policy.perPhoneDaily.limit,
    policy.perPhoneDaily.windowSeconds,
  );
  if (dailyFree) {
    return refuse('phone_daily', dailyFree);
  }
  const ipTimes = within(input.ipTimes, now, policy.perIp.windowSeconds);
  const ipFree = windowFreesAt(ipTimes, policy.perIp.limit, policy.perIp.windowSeconds);
  if (ipFree) {
    return refuse('ip', ipFree);
  }

  // The same rules once this request is counted: the earliest moment every one of them allows
  // the next code.
  const candidates = [
    new Date(now.getTime() + ms(policy.cooldownSeconds)),
    windowFreesAt([...windowTimes, now], policy.perPhone.limit, policy.perPhone.windowSeconds),
    windowFreesAt(
      [...dailyTimes, now],
      policy.perPhoneDaily.limit,
      policy.perPhoneDaily.windowSeconds,
    ),
    windowFreesAt([...ipTimes, now], policy.perIp.limit, policy.perIp.windowSeconds),
  ].filter((value): value is Date => value !== null);
  const resendAvailableAt = new Date(Math.max(...candidates.map((value) => value.getTime())));
  return {
    allowed: true,
    resendAvailableAt,
    phoneDailyCount: dailyTimes.length,
    ipCount: ipTimes.length,
  };
}

/** Soft thresholds for the captcha hook; a threshold of 0 disables that trigger. */
export function needsCaptcha(
  counts: { phoneDaily: number; ip: number },
  thresholds: { phone: number; ip: number },
): boolean {
  return (
    (thresholds.phone > 0 && counts.phoneDaily >= thresholds.phone) ||
    (thresholds.ip > 0 && counts.ip >= thresholds.ip)
  );
}

export type SmsBudgetDecision =
  | { allowed: true; /** True when this SMS makes usage reach the alert share. */ alert: boolean }
  | { allowed: false };

/**
 * Global daily SMS budget. `usedToday` counts codes created since the start of the Kyiv day,
 * before this one. `alert` is true for the SMS that reaches `alertPercent` of the budget.
 */
export function checkSmsBudget(
  usedToday: number,
  budget: number,
  alertPercent: number,
): SmsBudgetDecision {
  if (usedToday >= budget) {
    return { allowed: false };
  }
  const threshold = Math.ceil((budget * alertPercent) / 100);
  return { allowed: true, alert: usedToday + 1 >= threshold };
}

/**
 * HMAC-SHA256 with the server pepper (brief section 1), bound to the challenge and the phone
 * so a hash cannot be replayed against another challenge. Hex, 64 characters (OtpChallenge.codeHash).
 */
export function hashOtpCode(
  pepper: string,
  challengeId: string,
  phone: string,
  code: string,
): string {
  return hmacSha256Hex(pepper, 'otp', challengeId, phone, code);
}

export interface OtpChallengeLike {
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
}

export type OtpAttemptOutcome =
  'ok' | 'not_found' | 'consumed' | 'expired' | 'too_many_attempts' | 'invalid';

export interface OtpAttemptResult {
  outcome: OtpAttemptOutcome;
  /** Attempts counter after this evaluation (what the row should store). */
  attempts: number;
  attemptsLeft: number;
}

/**
 * Decides what a verification attempt means for the latest challenge of a phone.
 * `codeMatches` is computed by the caller (constant-time hash comparison).
 * Only the latest challenge counts: requesting a new code invalidates the previous one.
 */
export function evaluateOtpAttempt(
  challenge: OtpChallengeLike | null,
  now: Date,
  codeMatches: boolean,
): OtpAttemptResult {
  if (!challenge) {
    return { outcome: 'not_found', attempts: 0, attemptsLeft: 0 };
  }
  const left = Math.max(challenge.maxAttempts - challenge.attempts, 0);
  if (challenge.consumedAt) {
    return { outcome: 'consumed', attempts: challenge.attempts, attemptsLeft: left };
  }
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'expired', attempts: challenge.attempts, attemptsLeft: left };
  }
  if (left <= 0) {
    return { outcome: 'too_many_attempts', attempts: challenge.attempts, attemptsLeft: 0 };
  }
  const attempts = challenge.attempts + 1;
  const attemptsLeft = Math.max(challenge.maxAttempts - attempts, 0);
  if (!codeMatches) {
    return {
      outcome: attemptsLeft === 0 ? 'too_many_attempts' : 'invalid',
      attempts,
      attemptsLeft,
    };
  }
  return { outcome: 'ok', attempts, attemptsLeft };
}

/** Ukrainian SMS text; the code is the only variable part, so templates stay predictable for filters. */
export function buildOtpSmsText(code: string, ttlSeconds: number): string {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return `Порт City: ваш код ${code}. Дійсний ${minutes} хв. Нікому не повідомляйте цей код.`;
}
