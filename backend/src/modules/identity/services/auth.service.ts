import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { randomDigits, safeEqual } from '../../../common/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import {
  IDENTITY_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { maskPhone, normalizeUaPhone } from '../../../common/phone/phone';
import { ipRateLimitKey } from '../../../common/throttling/ip-key';
import { Clock } from '../../../common/time/clock';
import { kyivDayKey, startOfKyivDay } from '../../../common/time/kyiv';
import { type ConsentChange, planConsentChanges } from '../domain/consents';
import { IdentityErrors } from '../domain/errors';
import { withCurrentVersions } from '../domain/legal';
import { generateMemberCode } from '../domain/member-code';
import {
  DAY_SECONDS,
  type OtpAttemptOutcome,
  type OtpPhoneHistoryRow,
  type OtpRequestDecision,
  type OtpRequestPolicy,
  buildOtpSmsText,
  checkSmsBudget,
  decideOtpRequest,
  evaluateOtpAttempt,
  evaluateOtpFailures,
  hashOtpCode,
  needsCaptcha,
} from '../domain/otp';
import { assertUserCanAuthenticate } from '../domain/user-status';
import type { OtpRequestResponseDto, OtpVerifyResponseDto } from '../dto/auth.dto';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';
import { CaptchaVerifierPort } from './captcha.port';
import { applyConsentOps } from './consent-ops';
import { DevicesService, type LoginDeviceInfo } from './devices.service';
import {
  type IdentityReads,
  IdentityStore,
  type IdentityUow,
  StoreConflictError,
} from './identity.store';
import { toUserDto } from './mappers';
import { SessionService, toSessionTokensDto } from './session.service';
import { SmsPort } from './sms.port';

export interface OtpRequestInput {
  phone: string;
  /** Client address as Express reports it (honours TRUST_PROXY); keyed by ipRateLimitKey(). */
  ip: string | null;
  fingerprint?: string | null;
  /** Answer of the captcha challenge, required only above the soft thresholds. */
  captchaToken?: string | null;
}

/** Upper bound of IP request times read per decision (the IP limit itself is far lower). */
const IP_TIMES_READ_LIMIT = 1000;

export interface OtpVerifyInput {
  phone: string;
  code: string;
  device: LoginDeviceInfo;
  /** Optional consents accepted on the login screen (e.g. program terms version). */
  consents?: ConsentChange[];
}

/** Attempts to pick an unused member code before inserting (the unique index is the real guard). */
const MEMBER_CODE_PICK_ATTEMPTS = 5;
/** A unique violation aborts the transaction, so the whole login is retried a few times. */
const LOGIN_TX_ATTEMPTS = 3;

const OTP_FAILURES: Record<Exclude<OtpAttemptOutcome, 'ok'>, { code: string; message: string }> = {
  not_found: { code: IdentityErrors.PC_OTP_INVALID, message: 'Request a code first' },
  consumed: {
    code: IdentityErrors.PC_OTP_INVALID,
    message: 'This code was already used; request a new one',
  },
  expired: {
    code: IdentityErrors.PC_OTP_EXPIRED,
    message: 'The code has expired; request a new one',
  },
  too_many_attempts: {
    code: IdentityErrors.PC_OTP_TOO_MANY_ATTEMPTS,
    message: 'Too many wrong codes; request a new one',
  },
  invalid: { code: IdentityErrors.PC_OTP_INVALID, message: 'The code is wrong' },
};

function otpFailure(outcome: Exclude<OtpAttemptOutcome, 'ok'>, attemptsLeft: number): DomainError {
  const failure = OTP_FAILURES[outcome];
  return new DomainError(failure.code, failure.message, { details: { attemptsLeft } });
}

/**
 * Member login by SMS code (brief sections 3 and 8): `POST /auth/otp/request` and
 * `POST /auth/otp/verify`. Codes are 6 digits, live 5 minutes, allow 5 attempts and are stored
 * only as HMAC-SHA256 with the server pepper.
 *
 * Abuse protection (counted on otp_challenges, so it holds across API replicas without Redis):
 * a resend cooldown, 3 codes per phone per 10 minutes, 5 per phone per 24 hours, 10 per IP
 * network per hour (IPv6 counted per /64), a phone lock after 10 wrong codes in 24 hours, a
 * global daily SMS budget with an alert at 80 %, and a captcha hook above soft thresholds. The
 * count-then-insert runs under per-phone and per-IP advisory locks, so parallel requests cannot
 * overshoot a limit; the route additionally carries a throttler limit per IP.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Kyiv days for which this replica already logged the budget alert / exhaustion. */
  private budgetAlertDay: string | null = null;
  private budgetExhaustedDay: string | null = null;

  constructor(
    private readonly store: IdentityStore,
    private readonly sessions: SessionService,
    private readonly devices: DevicesService,
    private readonly sms: SmsPort,
    private readonly captcha: CaptchaVerifierPort,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  async requestOtp(input: OtpRequestInput): Promise<OtpRequestResponseDto> {
    const phone = normalizeUaPhone(input.phone);
    const now = this.clock.now();
    const ipKey = ipRateLimitKey(input.ip);
    const policy = this.requestPolicy();

    // Read-only preview outside the transaction: refuse early and call the captcha provider
    // without holding any lock (it is an external HTTP call).
    const preview = await this.evaluateRequest(this.store, phone, ipKey, now, policy);
    if (!preview.allowed) {
      throw this.requestRefused(preview);
    }
    if (
      needsCaptcha(
        { phoneDaily: preview.phoneDailyCount, ip: preview.ipCount },
        {
          phone: this.config.OTP_CAPTCHA_PHONE_THRESHOLD,
          ip: this.config.OTP_CAPTCHA_IP_THRESHOLD,
        },
      )
    ) {
      const token = input.captchaToken?.trim() ? input.captchaToken.trim() : null;
      if (!(await this.captcha.verify({ token, action: 'otp_request', ip: ipKey, phone }))) {
        throw new DomainError(
          IdentityErrors.PC_OTP_CAPTCHA_REQUIRED,
          'Confirm that you are not a robot and request the code again',
          { details: { reason: token ? 'invalid' : 'missing' } },
        );
      }
    }

    const staticCode = this.config.OTP_STATIC_CODES[phone];
    const code = staticCode ?? randomDigits(this.config.OTP_CODE_LENGTH);
    const id = uuidv7();
    const expiresAt = new Date(now.getTime() + this.config.OTP_TTL_SECONDS * 1000);
    const fingerprint = input.fingerprint?.trim() ? input.fingerprint.trim().slice(0, 128) : null;

    const decision = await this.store.run(async (uow) => {
      // Count-then-insert is atomic per phone and per IP network (advisory locks).
      await uow.lockOtpRequest(phone, ipKey);
      const fresh = await this.evaluateRequest(uow, phone, ipKey, now, policy);
      if (!fresh.allowed) {
        throw this.requestRefused(fresh);
      }
      if (!staticCode) {
        await this.checkSmsBudget(uow, now);
      }
      await uow.createOtpChallenge({
        id,
        phone,
        codeHash: hashOtpCode(this.appConfig.OTP_PEPPER, id, phone, code),
        expiresAt,
        maxAttempts: this.config.OTP_MAX_ATTEMPTS,
        ip: ipKey,
        deviceFingerprint: fingerprint,
        createdAt: now,
      });
      return fresh;
    });

    if (staticCode) {
      this.logger.log(`Static OTP code used for ${maskPhone(phone)}; no SMS sent`);
    } else {
      await this.sms.send({ phone, text: buildOtpSmsText(code, this.config.OTP_TTL_SECONDS) });
    }

    const response: OtpRequestResponseDto = {
      phone,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: decision.resendAvailableAt.toISOString(),
      codeLength: code.length,
      maxAttempts: this.config.OTP_MAX_ATTEMPTS,
    };
    if (this.config.OTP_DEV_ECHO && !this.appConfig.isProduction) {
      response.debugCode = code;
    }
    return response;
  }

  async verifyOtp(input: OtpVerifyInput): Promise<OtpVerifyResponseDto> {
    const phone = normalizeUaPhone(input.phone);
    const now = this.clock.now();
    const failurePolicy = {
      limit: this.config.OTP_VERIFY_FAILURE_LIMIT,
      windowSeconds: this.config.OTP_VERIFY_FAILURE_WINDOW_SECONDS,
    };
    const failureSince = new Date(now.getTime() - failurePolicy.windowSeconds * 1000);
    const lockOf = (rows: OtpPhoneHistoryRow[]) => evaluateOtpFailures(rows, now, failurePolicy);

    const early = lockOf(await this.store.listOtpPhoneHistory(phone, failureSince));
    if (early.locked && early.lockedUntil) {
      throw this.phoneLocked(early.lockedUntil, now);
    }
    const challenge = await this.store.findLatestOtpChallenge(phone);

    // Preconditions on the snapshot (exists, unused, not expired, attempts left), code not yet looked at.
    const precheck = evaluateOtpAttempt(challenge, now, true);
    if (!challenge || precheck.outcome !== 'ok') {
      throw otpFailure(precheck.outcome === 'ok' ? 'not_found' : precheck.outcome, 0);
    }

    // The attempt is counted atomically before the code is compared, so parallel guesses
    // cannot get more than maxAttempts tries at one code; under the phone lock the 24-hour
    // wrong-code cap is re-checked, so parallel guesses cannot overshoot it either.
    const claim = await this.store.run(async (uow) => {
      await uow.lockOtpRequest(phone, null);
      const lock = lockOf(await uow.listOtpPhoneHistory(phone, failureSince));
      if (lock.locked && lock.lockedUntil) {
        return { lockedUntil: lock.lockedUntil, attempts: null };
      }
      return {
        lockedUntil: null,
        attempts: await uow.claimOtpAttempt(challenge.id, challenge.maxAttempts),
      };
    });
    if (claim.lockedUntil) {
      throw this.phoneLocked(claim.lockedUntil, now);
    }
    const attempts = claim.attempts;
    if (attempts === null) {
      const fresh = await this.store.findLatestOtpChallenge(phone);
      throw otpFailure(fresh?.consumedAt ? 'consumed' : 'too_many_attempts', 0);
    }
    const codeMatches = safeEqual(
      hashOtpCode(this.appConfig.OTP_PEPPER, challenge.id, phone, input.code.trim()),
      challenge.codeHash,
    );
    const attempt = evaluateOtpAttempt({ ...challenge, attempts: attempts - 1 }, now, codeMatches);
    if (attempt.outcome !== 'ok') {
      throw otpFailure(attempt.outcome, attempt.attemptsLeft);
    }
    const challengeId = challenge.id;

    for (let attemptNo = 1; ; attemptNo += 1) {
      try {
        return await this.store.run((uow) =>
          this.completeLogin(uow, challengeId, phone, input, now),
        );
      } catch (error) {
        const retryable =
          StoreConflictError.is(error) && (error.has('member_code') || error.has('phone'));
        if (!retryable || attemptNo >= LOGIN_TX_ATTEMPTS) {
          throw error;
        }
        this.logger.warn(`Login transaction retried after ${error.message}`);
      }
    }
  }

  private async completeLogin(
    uow: IdentityUow,
    challengeId: string,
    phone: string,
    input: OtpVerifyInput,
    now: Date,
  ): Promise<OtpVerifyResponseDto> {
    if (!(await uow.consumeOtpChallenge(challengeId, now))) {
      throw otpFailure('consumed', 0);
    }

    let user = await uow.findUserByPhone(phone);
    const isNewUser = user === null;
    if (user) {
      assertUserCanAuthenticate(user.status);
    } else {
      user = await uow.createUser({
        id: uuidv7(),
        phone,
        memberCode: await this.pickMemberCode(uow),
        createdAt: now,
      });
    }

    const { device } = await this.devices.upsertLoginDevice(uow, user.id, input.device, now);

    if (input.consents && input.consents.length > 0) {
      const ops = planConsentChanges(
        await uow.listConsents(user.id),
        withCurrentVersions(input.consents, this.config),
      );
      await applyConsentOps(uow, user.id, ops, now);
    }

    if (isNewUser) {
      await uow.publish(
        buildOutboxEvent(IDENTITY_EVENTS.registered, OUTBOX_AGGREGATES.user, user.id, {
          userId: user.id,
          memberCode: user.memberCode,
          deviceId: device.id,
          registeredAt: now.toISOString(),
        }),
      );
    }

    const session = await this.sessions.startSession(uow, user.id, device.id, now);
    const fresh: User = (await uow.findUserById(user.id)) ?? user;
    return {
      ...toSessionTokensDto(session),
      isNewUser,
      user: toUserDto(fresh),
      deviceId: device.id,
    };
  }

  private requestPolicy(): OtpRequestPolicy {
    return {
      cooldownSeconds: this.config.OTP_RESEND_COOLDOWN_SECONDS,
      perPhone: {
        limit: this.config.OTP_PHONE_LIMIT,
        windowSeconds: this.config.OTP_PHONE_WINDOW_SECONDS,
      },
      perPhoneDaily: { limit: this.config.OTP_PHONE_DAILY_LIMIT, windowSeconds: DAY_SECONDS },
      perIp: { limit: this.config.OTP_IP_LIMIT, windowSeconds: this.config.OTP_IP_WINDOW_SECONDS },
      failures: {
        limit: this.config.OTP_VERIFY_FAILURE_LIMIT,
        windowSeconds: this.config.OTP_VERIFY_FAILURE_WINDOW_SECONDS,
      },
    };
  }

  private async evaluateRequest(
    reads: IdentityReads,
    phone: string,
    ipKey: string | null,
    now: Date,
    policy: OtpRequestPolicy,
  ): Promise<OtpRequestDecision> {
    const historySeconds = Math.max(
      DAY_SECONDS,
      policy.failures.windowSeconds,
      policy.perPhone.windowSeconds,
      policy.cooldownSeconds,
    );
    const [phoneRows, ipTimes] = await Promise.all([
      reads.listOtpPhoneHistory(phone, new Date(now.getTime() - historySeconds * 1000)),
      ipKey
        ? reads.listOtpRequestTimes(
            { ip: ipKey, since: new Date(now.getTime() - policy.perIp.windowSeconds * 1000) },
            IP_TIMES_READ_LIMIT,
          )
        : Promise.resolve([]),
    ]);
    return decideOtpRequest({ phone: phoneRows, ipTimes, now, policy });
  }

  private requestRefused(decision: Extract<OtpRequestDecision, { allowed: false }>): DomainError {
    if (decision.reason === 'locked') {
      return new DomainError(
        IdentityErrors.PC_OTP_LOCKED,
        'Too many wrong codes for this phone; try again later',
        {
          details: {
            retryAfterSeconds: decision.retryAfterSeconds,
            lockedUntil: decision.until.toISOString(),
          },
        },
      );
    }
    const messages: Record<Exclude<typeof decision.reason, 'locked'>, string> = {
      cooldown: 'A code was sent a moment ago; wait before requesting another one',
      phone: 'Too many codes requested for this phone; try again later',
      phone_daily: 'The daily number of codes for this phone is used up; try again later',
      ip: 'Too many codes requested from this network; try again later',
    };
    return new DomainError(IdentityErrors.PC_OTP_RATE_LIMITED, messages[decision.reason], {
      details: {
        scope: decision.reason,
        retryAfterSeconds: decision.retryAfterSeconds,
        retryAt: decision.until.toISOString(),
      },
    });
  }

  private phoneLocked(lockedUntil: Date, now: Date): DomainError {
    return new DomainError(
      IdentityErrors.PC_OTP_LOCKED,
      'Too many wrong codes for this phone; try again later',
      {
        details: {
          retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
          lockedUntil: lockedUntil.toISOString(),
        },
      },
    );
  }

  /** Global daily SMS budget (Kyiv calendar day); warns once per replica and day at the alert share. */
  private async checkSmsBudget(uow: IdentityUow, now: Date): Promise<void> {
    const dayStart = startOfKyivDay(now);
    const used = await uow.countOtpChallenges({ since: new Date(dayStart.getTime() - 1) });
    const budget = this.config.SMS_DAILY_BUDGET;
    const decision = checkSmsBudget(used, budget, this.config.SMS_BUDGET_ALERT_PERCENT);
    const day = kyivDayKey(now);
    if (!decision.allowed) {
      if (this.budgetExhaustedDay !== day) {
        this.budgetExhaustedDay = day;
        this.logger.error(
          `SMS daily budget exhausted: ${used} of ${budget} codes on ${day} (Kyiv); OTP requests refused until midnight`,
        );
      }
      const nextDay = new Date(dayStart.getTime() + DAY_SECONDS * 1000);
      const reopen = startOfKyivDay(new Date(nextDay.getTime() + 2 * 3_600_000));
      throw new DomainError(
        IdentityErrors.PC_OTP_SMS_BUDGET_EXHAUSTED,
        'Login codes are temporarily unavailable; try again later',
        {
          details: {
            retryAfterSeconds: Math.max(1, Math.ceil((reopen.getTime() - now.getTime()) / 1000)),
          },
        },
      );
    }
    if (decision.alert && this.budgetAlertDay !== day) {
      this.budgetAlertDay = day;
      this.logger.warn(
        `SMS daily budget at ${Math.floor(((used + 1) * 100) / budget)} %: ${used + 1} of ${budget} codes on ${day} (Kyiv); alert threshold ${this.config.SMS_BUDGET_ALERT_PERCENT} %`,
      );
    }
  }

  private async pickMemberCode(uow: IdentityUow): Promise<string> {
    const next = (): string => generateMemberCode((max) => randomInt(0, max));
    let code = next();
    for (
      let index = 1;
      index < MEMBER_CODE_PICK_ATTEMPTS && (await uow.findUserByMemberCode(code)) !== null;
      index += 1
    ) {
      code = next();
    }
    return code;
  }
}
