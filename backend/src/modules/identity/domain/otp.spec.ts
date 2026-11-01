import {
  type OtpAttemptOutcome,
  type OtpChallengeLike,
  type OtpPhoneHistoryRow,
  type OtpRequestPolicy,
  buildOtpSmsText,
  challengeFailures,
  checkSmsBudget,
  decideOtpRequest,
  evaluateOtpAttempt,
  evaluateOtpFailures,
  hashOtpCode,
  needsCaptcha,
} from './otp';

const POLICY: OtpRequestPolicy = {
  cooldownSeconds: 60,
  perPhone: { limit: 3, windowSeconds: 600 },
  perPhoneDaily: { limit: 5, windowSeconds: 86_400 },
  perIp: { limit: 10, windowSeconds: 3600 },
  failures: { limit: 10, windowSeconds: 86_400 },
};
const NOW = new Date('2026-03-10T10:00:00.000Z');
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const sent = (secondsAgo: number, attempts = 0, consumed = false): OtpPhoneHistoryRow => ({
  createdAt: ago(secondsAgo),
  attempts,
  consumedAt: consumed ? ago(secondsAgo - 10) : null,
});

describe('decideOtpRequest', () => {
  const decide = (phone: OtpPhoneHistoryRow[], ipTimes: Date[] = []) =>
    decideOtpRequest({ phone, ipTimes, now: NOW, policy: POLICY });

  it('allows the first code and offers a resend after the cooldown', () => {
    expect(decide([])).toEqual({
      allowed: true,
      resendAvailableAt: new Date('2026-03-10T10:01:00.000Z'),
      phoneDailyCount: 0,
      ipCount: 0,
    });
  });

  it.each<[string, OtpPhoneHistoryRow[], Date[], string, number]>([
    ['cooldown after a code 20 s ago', [sent(20)], [], 'cooldown', 40],
    ['3 codes in 10 minutes', [sent(500), sent(300), sent(100)], [], 'phone', 100],
    [
      '5 codes in 24 hours',
      [sent(80_000), sent(70_000), sent(60_000), sent(50_000), sent(4000)],
      [],
      'phone_daily',
      6400,
    ],
    [
      '10 codes from the network in an hour',
      [],
      Array.from({ length: 10 }, (_, index) => ago(3000 - index * 10)),
      'ip',
      600,
    ],
    [
      '10 wrong codes in 24 hours lock the phone',
      [sent(7200, 5), sent(3600, 5)],
      [],
      'locked',
      79_200,
    ],
  ])('refuses: %s', (_name, phone, ipTimes, reason, retryAfterSeconds) => {
    expect(decide(phone, ipTimes)).toMatchObject({ allowed: false, reason, retryAfterSeconds });
  });

  it('checks the lock before the cooldown and the windows', () => {
    expect(decide([sent(30, 5), sent(20, 5)])).toMatchObject({ reason: 'locked' });
  });

  it('pushes resendAvailableAt to the moment every limit allows the next code', () => {
    // Third code of the 10-minute window: the next one is possible when the oldest leaves it.
    expect(decide([sent(500), sent(300)])).toMatchObject({
      allowed: true,
      resendAvailableAt: new Date(ago(500).getTime() + 600_000),
    });
    // Fifth code of the day: the next one only after the oldest leaves the 24-hour window.
    const day = [sent(80_000), sent(70_000), sent(60_000), sent(50_000)];
    expect(decide(day)).toMatchObject({
      allowed: true,
      resendAvailableAt: new Date(ago(80_000).getTime() + 86_400_000),
      phoneDailyCount: 4,
    });
  });

  it('ignores codes outside the windows and reports counts for the captcha thresholds', () => {
    const decision = decide([sent(90_000), sent(700)], [ago(4000), ago(100)]);
    expect(decision).toMatchObject({ allowed: true, phoneDailyCount: 1, ipCount: 1 });
  });
});

describe('evaluateOtpFailures', () => {
  const policy = { limit: 10, windowSeconds: 86_400 };

  it('counts wrong codes over every challenge of the window, not the successful attempt', () => {
    expect(challengeFailures(sent(10, 3, true))).toBe(2);
    expect(challengeFailures(sent(10, 3))).toBe(3);
    expect(evaluateOtpFailures([sent(100, 4), sent(50, 3, true)], NOW, policy)).toEqual({
      failures: 6,
      locked: false,
      lockedUntil: null,
    });
  });

  it('locks at the limit until enough failures leave the window', () => {
    const rows = [sent(80_000, 2), sent(7200, 5), sent(3600, 5)];
    expect(evaluateOtpFailures(rows, NOW, policy)).toEqual({
      failures: 12,
      locked: true,
      // Dropping the 80 000 s row leaves 10, still locked; dropping the 7200 s row unlocks.
      lockedUntil: new Date(ago(7200).getTime() + 86_400_000),
    });
    expect(evaluateOtpFailures([sent(90_000, 5), sent(3600, 5)], NOW, policy).locked).toBe(false);
  });
});

describe('needsCaptcha', () => {
  it.each([
    [{ phoneDaily: 2, ip: 4 }, false],
    [{ phoneDaily: 3, ip: 0 }, true],
    [{ phoneDaily: 0, ip: 5 }, true],
  ])('%j -> %s', (counts, expected) => {
    expect(needsCaptcha(counts, { phone: 3, ip: 5 })).toBe(expected);
  });

  it('treats a threshold of 0 as disabled', () => {
    expect(needsCaptcha({ phoneDaily: 50, ip: 50 }, { phone: 0, ip: 0 })).toBe(false);
  });
});

describe('checkSmsBudget', () => {
  it('alerts on the SMS that reaches the alert share and refuses beyond the budget', () => {
    expect(checkSmsBudget(0, 100, 80)).toEqual({ allowed: true, alert: false });
    expect(checkSmsBudget(78, 100, 80)).toEqual({ allowed: true, alert: false });
    expect(checkSmsBudget(79, 100, 80)).toEqual({ allowed: true, alert: true });
    expect(checkSmsBudget(99, 100, 80)).toEqual({ allowed: true, alert: true });
    expect(checkSmsBudget(100, 100, 80)).toEqual({ allowed: false });
  });
});

describe('hashOtpCode', () => {
  it('is deterministic, hex and bound to challenge and phone', () => {
    const hash = hashOtpCode('pepper', 'challenge-1', '+380501234567', '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtpCode('pepper', 'challenge-1', '+380501234567', '123456')).toBe(hash);
    expect(hashOtpCode('pepper', 'challenge-2', '+380501234567', '123456')).not.toBe(hash);
    expect(hashOtpCode('pepper', 'challenge-1', '+380501234568', '123456')).not.toBe(hash);
    expect(hashOtpCode('other', 'challenge-1', '+380501234567', '123456')).not.toBe(hash);
  });
});

describe('evaluateOtpAttempt', () => {
  const now = new Date('2026-01-15T10:00:00Z');
  const base: OtpChallengeLike = {
    expiresAt: new Date('2026-01-15T10:05:00Z'),
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
  };

  const cases: Array<
    [string, OtpChallengeLike | null, boolean, OtpAttemptOutcome, number, number]
  > = [
    ['no challenge', null, true, 'not_found', 0, 0],
    ['consumed', { ...base, consumedAt: new Date('2026-01-15T09:59:00Z') }, true, 'consumed', 0, 5],
    ['expired exactly now', { ...base, expiresAt: now }, true, 'expired', 0, 5],
    [
      'expired earlier',
      { ...base, expiresAt: new Date('2026-01-15T09:00:00Z') },
      true,
      'expired',
      0,
      5,
    ],
    ['attempts exhausted before', { ...base, attempts: 5 }, true, 'too_many_attempts', 5, 0],
    ['wrong code, attempts left', { ...base, attempts: 1 }, false, 'invalid', 2, 3],
    ['wrong code, last attempt', { ...base, attempts: 4 }, false, 'too_many_attempts', 5, 0],
    ['correct code', base, true, 'ok', 1, 4],
    ['correct code on last attempt', { ...base, attempts: 4 }, true, 'ok', 5, 0],
  ];

  it.each(cases)('%s', (_name, challenge, matches, outcome, attempts, left) => {
    expect(evaluateOtpAttempt(challenge, now, matches)).toEqual({
      outcome,
      attempts,
      attemptsLeft: left,
    });
  });
});

describe('buildOtpSmsText', () => {
  it('contains the code and the validity in minutes', () => {
    expect(buildOtpSmsText('482913', 300)).toContain('482913');
    expect(buildOtpSmsText('482913', 300)).toContain('5 хв');
    expect(buildOtpSmsText('482913', 30)).toContain('1 хв');
  });
});
