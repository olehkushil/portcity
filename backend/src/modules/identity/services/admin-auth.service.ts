import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminUser } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  ConcurrencyLimitExceededError,
  ConcurrencyLimiter,
} from '../../../common/auth/concurrency-limiter';
import {
  type ScryptParams,
  hashPassword,
  hmacSha256,
  needsRehash,
  scryptParamsWithLogN,
  sha256Hex,
  verifyPassword,
} from '../../../common/auth/crypto';
import { TokenService } from '../../../common/auth/token.service';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { DomainError } from '../../../common/errors/domain-error';
import { ipRateLimitKey } from '../../../common/throttling/ip-key';
import { Clock } from '../../../common/time/clock';
import { type AdminLockPolicy, decideAdminLogin, isAdminLocked } from '../domain/admin-login';
import { IdentityErrors } from '../domain/errors';
import { FailureBurstTracker } from '../domain/failure-burst';
import { signStatelessToken, verifyStatelessToken } from '../domain/signed-token';
import { buildTotpUri, generateTotpSecret, matchTotpStep } from '../domain/totp';
import type { AdminUserDto } from '../dto/common.dto';
import type { AdminLoginResponseDto, AdminTotpSetupResponseDto } from '../dto/admin.dto';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';
import { IdentityStore, type IdentityUow } from './identity.store';
import { toAdminUserDto } from './mappers';

export const ADMIN_LOGIN_CHALLENGE_PURPOSE = 'admin-login-totp';
export const ADMIN_TOTP_SETUP_PURPOSE = 'admin-totp-setup';
/** Issued with PC_ADMIN_TOTP_SETUP_REQUIRED: password accepted, TOTP must be enrolled first. */
export const ADMIN_TOTP_ENROLL_PURPOSE = 'admin-totp-enroll';
/** Setup token of the enrollment flow (secret shown, first code pending, no admin token yet). */
export const ADMIN_TOTP_ENROLL_SETUP_PURPOSE = 'admin-totp-enroll-setup';
/** Audit actor of the burst detector. */
export const ADMIN_LOGIN_GUARD_ACTOR = 'admin-login-guard';

export interface AdminLoginInput {
  email: string;
  password: string;
  code?: string;
  ip?: string | null;
}

type FailureReason = 'invalid_password' | 'totp_invalid' | 'totp_replayed';
type LoginMethod = 'password' | 'password+totp';

/** Short fingerprint of the password hash: a password change voids pending login challenges. */
function passwordVersion(admin: AdminUser): string {
  return sha256Hex(admin.passwordHash).slice(0, 16);
}

/**
 * Back-office authentication (brief section 3): e-mail + scrypt password + TOTP.
 * - `POST /admin/auth/login` answers with an admin access token, or 401 PC_ADMIN_TOTP_REQUIRED
 *   whose `details.challengeToken` is exchanged at `POST /admin/auth/totp` together with the code
 *   (the code may also be sent with the password in one step). The challenge is single-use and
 *   allows ADMIN_TOTP_CHALLENGE_MAX_ATTEMPTS codes (its jti is stored on the admin row).
 * - Roles in ADMIN_REQUIRE_TOTP_ROLES (default owner, manager) cannot sign in without TOTP: a valid
 *   password answers 403 PC_ADMIN_TOTP_SETUP_REQUIRED with `details.enrollmentToken`, which
 *   `POST /admin/auth/totp/enroll` and `/enroll/confirm` turn into an enabled TOTP and a token.
 * - Every wrong password or TOTP code of a known account increments `failedLoginCount`; from
 *   ADMIN_LOGIN_LOCK_THRESHOLD failures the account is locked with exponential backoff
 *   (429 PC_ADMIN_LOGIN_LOCKED). Failures are audited; a burst from one IP network is logged and
 *   audited once per window.
 * - scrypt verification (128 MiB at N = 2^17) runs behind a small semaphore; beyond its queue the
 *   endpoint answers 429 PC_ADMIN_LOGIN_BUSY instead of exhausting memory. Weaker stored hashes are
 *   upgraded on a successful password check.
 * Admin sessions have no refresh token: the access token lives ADMIN_ACCESS_TTL_SECONDS and the
 * shared AdminGuard re-checks activity and role on every request (AdminAccessGate). Every accepted
 * TOTP code claims its time step (AdminUser.totpLastStep), so a code cannot be replayed.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly statelessSecret: string;
  private readonly passwordParams: ScryptParams;
  private readonly scryptLimiter: ConcurrencyLimiter;
  private readonly bursts: FailureBurstTracker;
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly store: IdentityStore,
    private readonly tokens: TokenService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) appConfig: AppConfig,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {
    this.statelessSecret = hmacSha256(appConfig.JWT_SECRET, 'identity', 'admin-stateless-token');
    this.passwordParams = scryptParamsWithLogN(config.ADMIN_PASSWORD_SCRYPT_LOG_N);
    this.scryptLimiter = new ConcurrencyLimiter(
      config.ADMIN_SCRYPT_MAX_CONCURRENT,
      config.ADMIN_SCRYPT_MAX_QUEUE,
    );
    this.bursts = new FailureBurstTracker(
      config.ADMIN_LOGIN_BURST_WINDOW_SECONDS * 1000,
      config.ADMIN_LOGIN_BURST_THRESHOLD,
    );
  }

  /** scrypt parameters for new admin password hashes (AdminStaffService uses the same). */
  get passwordHashParams(): ScryptParams {
    return this.passwordParams;
  }

  async login(input: AdminLoginInput): Promise<AdminLoginResponseDto> {
    const email = input.email.trim().toLowerCase();
    const found = await this.store.findAdminByEmail(email);
    const now = this.clock.now();
    if (found && isAdminLocked(found, now)) {
      // The password is not even verified while locked: guessing makes no progress.
      await this.noteFailure(input.ip, now);
      throw this.locked(found, now);
    }

    let passwordValid = false;
    await this.withScrypt(async () => {
      if (found) {
        passwordValid = await verifyPassword(input.password, found.passwordHash);
      } else {
        // Unknown e-mails still pay for one scrypt run so timing does not reveal registered accounts.
        await verifyPassword(input.password, await this.getDummyHash());
      }
    });
    let admin = found;
    if (admin && passwordValid && admin.active) {
      admin = await this.upgradePasswordHash(admin, input.password);
    }

    const totpEnabled = admin?.totpSecret != null;
    const codeProvided = input.code !== undefined && input.code.trim() !== '';
    const codeStep =
      admin?.totpSecret != null && codeProvided
        ? matchTotpStep(admin.totpSecret, input.code ?? '', now.getTime(), this.toleranceSeconds)
        : null;

    const outcome = decideAdminLogin({
      adminFound: admin !== null,
      passwordValid,
      active: admin?.active ?? false,
      totpEnabled,
      totpRequiredForRole: admin ? this.totpRequiredFor(admin) : false,
      codeProvided,
      codeValid: codeStep !== null,
    });

    if (outcome === 'invalid_credentials' || !admin) {
      if (admin) {
        await this.registerFailure(admin, 'invalid_password', input.ip);
      } else {
        await this.noteFailure(input.ip, now);
      }
      throw new DomainError(
        IdentityErrors.PC_ADMIN_CREDENTIALS_INVALID,
        'Invalid email or password',
      );
    }

    switch (outcome) {
      case 'inactive':
        await this.auditFailure(admin, 'inactive', input.ip);
        throw new DomainError(
          IdentityErrors.PC_ADMIN_INACTIVE,
          'This admin account is deactivated',
        );
      case 'totp_setup_required':
        throw this.setupRequired(admin, now);
      case 'totp_required':
        throw await this.issueChallenge(admin, now);
      case 'totp_invalid':
        await this.registerFailure(admin, 'totp_invalid', input.ip);
        throw new DomainError(
          IdentityErrors.PC_ADMIN_TOTP_INVALID,
          'The authenticator code is wrong',
        );
      case 'ok':
        return totpEnabled
          ? this.completeLogin(admin, input.ip, 'password+totp', codeStep)
          : this.completeLogin(admin, input.ip, 'password', null);
    }
  }

  async completeTotp(
    challengeToken: string,
    code: string,
    ip?: string | null,
  ): Promise<AdminLoginResponseDto> {
    const now = this.clock.now();
    const payload = verifyStatelessToken(
      challengeToken,
      this.statelessSecret,
      ADMIN_LOGIN_CHALLENGE_PURPOSE,
      now,
    );
    const admin = payload ? await this.store.findAdminById(payload.subject) : null;
    const jti = payload?.data?.['jti'];
    if (
      !payload ||
      !admin ||
      !jti ||
      admin.totpSecret === null ||
      payload.data?.['pv'] !== passwordVersion(admin)
    ) {
      throw this.challengeInvalid();
    }
    if (isAdminLocked(admin, now)) {
      await this.noteFailure(ip, now);
      throw this.locked(admin, now);
    }
    if (!admin.active) {
      await this.auditFailure(admin, 'inactive', ip);
      throw new DomainError(IdentityErrors.PC_ADMIN_INACTIVE, 'This admin account is deactivated');
    }
    const maxAttempts = this.config.ADMIN_TOTP_CHALLENGE_MAX_ATTEMPTS;
    // Single use and bounded: the attempt is claimed against the stored jti before the code is
    // looked at; a used, superseded or exhausted challenge is dead.
    const attempt = await this.store.run((uow) =>
      uow.claimLoginChallengeAttempt(admin.id, jti, maxAttempts),
    );
    if (attempt === null) {
      throw this.challengeInvalid();
    }
    const step = matchTotpStep(admin.totpSecret, code, now.getTime(), this.toleranceSeconds);
    if (step === null) {
      await this.registerFailure(admin, 'totp_invalid', ip);
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_INVALID,
        'The authenticator code is wrong',
        { details: { attemptsLeft: Math.max(0, maxAttempts - attempt) } },
      );
    }
    return this.completeLogin(admin, ip, 'password+totp', step);
  }

  /**
   * Enrollment step 1 (no admin token yet): the enrollment token from PC_ADMIN_TOTP_SETUP_REQUIRED
   * buys a fresh secret and a setup token bound to the password version.
   */
  async startTotpEnrollment(enrollmentToken: string): Promise<AdminTotpSetupResponseDto> {
    const now = this.clock.now();
    const payload = verifyStatelessToken(
      enrollmentToken,
      this.statelessSecret,
      ADMIN_TOTP_ENROLL_PURPOSE,
      now,
    );
    const admin = payload ? await this.store.findAdminById(payload.subject) : null;
    if (!payload || !admin || payload.data?.['pv'] !== passwordVersion(admin)) {
      throw this.challengeInvalid();
    }
    this.assertCanEnroll(admin, now);
    const secret = generateTotpSecret();
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.config.ADMIN_TOTP_SETUP_TTL_SECONDS;
    const setupToken = signStatelessToken(
      {
        purpose: ADMIN_TOTP_ENROLL_SETUP_PURPOSE,
        subject: admin.id,
        expiresAt: expiresAtSeconds,
        data: { secret, pv: passwordVersion(admin) },
      },
      this.statelessSecret,
    );
    return {
      secret,
      otpauthUri: buildTotpUri(this.config.ADMIN_TOTP_ISSUER, admin.email, secret),
      setupToken,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    };
  }

  /** Enrollment step 2: the first code enables TOTP and completes the login in one transaction. */
  async confirmTotpEnrollment(
    setupToken: string,
    code: string,
    ip?: string | null,
  ): Promise<AdminLoginResponseDto> {
    const now = this.clock.now();
    const payload = verifyStatelessToken(
      setupToken,
      this.statelessSecret,
      ADMIN_TOTP_ENROLL_SETUP_PURPOSE,
      now,
    );
    const admin = payload ? await this.store.findAdminById(payload.subject) : null;
    const secret = payload?.data?.['secret'];
    if (!payload || !admin || !secret || payload.data?.['pv'] !== passwordVersion(admin)) {
      throw this.challengeInvalid();
    }
    this.assertCanEnroll(admin, now);
    const step = matchTotpStep(secret, code, now.getTime(), this.toleranceSeconds);
    if (step === null) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_INVALID,
        'The authenticator code is wrong',
      );
    }
    const updated = await this.store.run(async (uow) => {
      // The confirmation code is spent with the step: it cannot be replayed for another login.
      await uow.updateAdmin(admin.id, { totpSecret: secret, totpLastStep: step });
      await uow.audit({
        actor: { type: 'admin', id: admin.id },
        action: 'admin_user.totp_enable',
        entityType: 'admin_user',
        entityId: admin.id,
        before: { totpEnabled: false },
        after: { totpEnabled: true, via: 'login_enrollment' },
        ip: ip ?? null,
      });
      return this.recordLogin(uow, admin, now, 'password+totp', ip);
    });
    return this.issueAccessToken(updated);
  }

  async getMe(adminId: string): Promise<AdminUserDto> {
    return toAdminUserDto(await this.requireActiveAdmin(adminId));
  }

  /** Step 1 of enabling TOTP: a new secret and a signed setup token carrying it. */
  async setupTotp(adminId: string): Promise<AdminTotpSetupResponseDto> {
    const admin = await this.requireActiveAdmin(adminId);
    if (admin.totpSecret !== null) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_ALREADY_ENABLED,
        'TOTP is already enabled',
      );
    }
    const secret = generateTotpSecret();
    const expiresAtSeconds =
      Math.floor(this.clock.nowMs() / 1000) + this.config.ADMIN_TOTP_SETUP_TTL_SECONDS;
    const setupToken = signStatelessToken(
      {
        purpose: ADMIN_TOTP_SETUP_PURPOSE,
        subject: admin.id,
        expiresAt: expiresAtSeconds,
        data: { secret },
      },
      this.statelessSecret,
    );
    return {
      secret,
      otpauthUri: buildTotpUri(this.config.ADMIN_TOTP_ISSUER, admin.email, secret),
      setupToken,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    };
  }

  /** Step 2: the first code from the app proves the secret was saved; then it is stored. */
  async confirmTotp(
    adminId: string,
    setupToken: string,
    code: string,
    ip?: string | null,
  ): Promise<AdminUserDto> {
    const admin = await this.requireActiveAdmin(adminId);
    if (admin.totpSecret !== null) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_ALREADY_ENABLED,
        'TOTP is already enabled',
      );
    }
    const now = this.clock.now();
    const payload = verifyStatelessToken(
      setupToken,
      this.statelessSecret,
      ADMIN_TOTP_SETUP_PURPOSE,
      now,
    );
    const secret = payload?.data?.['secret'];
    if (!payload || payload.subject !== admin.id || !secret) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_CHALLENGE_INVALID,
        'The setup token is invalid or expired; start the setup again',
      );
    }
    const step = matchTotpStep(secret, code, now.getTime(), this.toleranceSeconds);
    if (step === null) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_INVALID,
        'The authenticator code is wrong',
      );
    }
    const updated = await this.store.run(async (uow) => {
      // The confirmation code is spent: it cannot be replayed for a login in the same window.
      const row = await uow.updateAdmin(admin.id, { totpSecret: secret, totpLastStep: step });
      await uow.audit({
        actor: { type: 'admin', id: admin.id },
        action: 'admin_user.totp_enable',
        entityType: 'admin_user',
        entityId: admin.id,
        before: { totpEnabled: false },
        after: { totpEnabled: true },
        ip: ip ?? null,
      });
      return row;
    });
    return toAdminUserDto(updated);
  }

  async disableTotp(adminId: string, code: string, ip?: string | null): Promise<AdminUserDto> {
    const admin = await this.requireActiveAdmin(adminId);
    if (admin.totpSecret === null) {
      throw new DomainError(IdentityErrors.PC_ADMIN_TOTP_NOT_ENABLED, 'TOTP is not enabled');
    }
    if (this.totpRequiredFor(admin)) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_REQUIRED_FOR_ROLE,
        `TOTP is mandatory for the ${admin.role} role`,
        { details: { role: admin.role } },
      );
    }
    const step = matchTotpStep(admin.totpSecret, code, this.clock.nowMs(), this.toleranceSeconds);
    if (step === null) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_INVALID,
        'The authenticator code is wrong',
      );
    }
    const updated = await this.store.run(async (uow) => {
      if (!(await uow.claimTotpStep(admin.id, step))) {
        throw this.totpReplayed();
      }
      const row = await uow.updateAdmin(admin.id, {
        totpSecret: null,
        totpLastStep: null,
        loginChallengeId: null,
        loginChallengeAttempts: 0,
      });
      await uow.audit({
        actor: { type: 'admin', id: admin.id },
        action: 'admin_user.totp_disable',
        entityType: 'admin_user',
        entityId: admin.id,
        before: { totpEnabled: true },
        after: { totpEnabled: false },
        ip: ip ?? null,
      });
      return row;
    });
    return toAdminUserDto(updated);
  }

  /** Admin tokens are stateless; identity's own admin endpoints re-check the account on every call. */
  async requireActiveAdmin(adminId: string): Promise<AdminUser> {
    const admin = await this.store.findAdminById(adminId);
    if (!admin) {
      throw new DomainError(IdentityErrors.PC_ADMIN_NOT_FOUND, 'Admin user not found');
    }
    if (!admin.active) {
      throw new DomainError(IdentityErrors.PC_ADMIN_INACTIVE, 'This admin account is deactivated');
    }
    return admin;
  }

  private get toleranceSeconds(): number {
    return this.config.ADMIN_TOTP_TOLERANCE_SECONDS;
  }

  private get lockPolicy(): AdminLockPolicy {
    return {
      threshold: this.config.ADMIN_LOGIN_LOCK_THRESHOLD,
      baseSeconds: this.config.ADMIN_LOGIN_LOCK_BASE_SECONDS,
      maxSeconds: this.config.ADMIN_LOGIN_LOCK_MAX_SECONDS,
      windowSeconds: this.config.ADMIN_LOGIN_FAILURE_WINDOW_SECONDS,
    };
  }

  private totpRequiredFor(admin: AdminUser): boolean {
    return this.config.ADMIN_REQUIRE_TOTP_ROLES.includes(admin.role);
  }

  /**
   * Runs scrypt work behind the semaphore. Beyond the queue the caller gets 429 at once: the
   * public login cannot be used to allocate unbounded 128 MiB buffers.
   */
  private async withScrypt<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await this.scryptLimiter.run(task);
    } catch (error) {
      if (ConcurrencyLimitExceededError.is(error)) {
        this.logger.warn(
          `Admin login refused: ${this.scryptLimiter.maxConcurrent} password checks running and ${this.scryptLimiter.maxQueue} queued`,
        );
        throw new DomainError(
          IdentityErrors.PC_ADMIN_LOGIN_BUSY,
          'Too many logins in progress; retry in a moment',
          { details: { retryAfterSeconds: 1 } },
        );
      }
      throw error;
    }
  }

  /** Replaces a hash weaker than the configured parameters after a successful password check. */
  private async upgradePasswordHash(admin: AdminUser, password: string): Promise<AdminUser> {
    if (!needsRehash(admin.passwordHash, this.passwordParams)) {
      return admin;
    }
    try {
      const passwordHash = await this.withScrypt(() => hashPassword(password, this.passwordParams));
      const updated = await this.store.run((uow) => uow.updateAdmin(admin.id, { passwordHash }));
      this.logger.log(
        `Password hash of admin ${admin.id} upgraded to scrypt ln=${Math.log2(this.passwordParams.N)}`,
      );
      return updated;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      // The login itself must not fail because the upgrade did; the next login retries it.
      this.logger.warn(
        `Password hash upgrade of admin ${admin.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return admin;
    }
  }

  private setupRequired(admin: AdminUser, now: Date): DomainError {
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.config.ADMIN_CHALLENGE_TTL_SECONDS;
    const enrollmentToken = signStatelessToken(
      {
        purpose: ADMIN_TOTP_ENROLL_PURPOSE,
        subject: admin.id,
        expiresAt: expiresAtSeconds,
        data: { pv: passwordVersion(admin) },
      },
      this.statelessSecret,
    );
    this.logger.log(`Admin ${admin.id} (${admin.role}) must enrol TOTP before signing in`);
    return new DomainError(
      IdentityErrors.PC_ADMIN_TOTP_SETUP_REQUIRED,
      'Your role requires an authenticator app; set it up to sign in',
      {
        details: {
          enrollmentToken,
          expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
          role: admin.role,
        },
      },
    );
  }

  /** Stores the jti of the new challenge (superseding any older one) and returns the 401. */
  private async issueChallenge(admin: AdminUser, now: Date): Promise<DomainError> {
    const jti = uuidv7();
    await this.store.run((uow) =>
      uow.updateAdmin(admin.id, { loginChallengeId: jti, loginChallengeAttempts: 0 }),
    );
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.config.ADMIN_CHALLENGE_TTL_SECONDS;
    const challengeToken = signStatelessToken(
      {
        purpose: ADMIN_LOGIN_CHALLENGE_PURPOSE,
        subject: admin.id,
        expiresAt: expiresAtSeconds,
        data: { pv: passwordVersion(admin), jti },
      },
      this.statelessSecret,
    );
    return new DomainError(IdentityErrors.PC_ADMIN_TOTP_REQUIRED, 'Enter the authenticator code', {
      details: {
        challengeToken,
        expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
        maxAttempts: this.config.ADMIN_TOTP_CHALLENGE_MAX_ATTEMPTS,
      },
    });
  }

  private assertCanEnroll(admin: AdminUser, now: Date): void {
    if (isAdminLocked(admin, now)) {
      throw this.locked(admin, now);
    }
    if (!admin.active) {
      throw new DomainError(IdentityErrors.PC_ADMIN_INACTIVE, 'This admin account is deactivated');
    }
    if (admin.totpSecret !== null) {
      throw new DomainError(
        IdentityErrors.PC_ADMIN_TOTP_ALREADY_ENABLED,
        'TOTP is already enabled; sign in with the authenticator code',
      );
    }
  }

  /**
   * Issues the admin token. With TOTP, `totpStep` (the matched time step) is claimed in the same
   * unit of work as `lastLoginAt`: a code whose step was already accepted (replay within its
   * 30-second window plus tolerance) is refused with PC_ADMIN_TOTP_INVALID.
   */
  private async completeLogin(
    admin: AdminUser,
    ip: string | null | undefined,
    method: LoginMethod,
    totpStep: number | null,
  ): Promise<AdminLoginResponseDto> {
    const now = this.clock.now();
    let updated: AdminUser;
    try {
      updated = await this.store.run(async (uow) => {
        if (totpStep !== null && !(await uow.claimTotpStep(admin.id, totpStep))) {
          throw this.totpReplayed();
        }
        return this.recordLogin(uow, admin, now, method, ip);
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === IdentityErrors.PC_ADMIN_TOTP_INVALID) {
        await this.registerFailure(admin, 'totp_replayed', ip);
      }
      throw error;
    }
    return this.issueAccessToken(updated);
  }

  private issueAccessToken(admin: AdminUser): AdminLoginResponseDto {
    const access = this.tokens.signAccessToken({
      sub: admin.id,
      type: 'admin',
      roles: [admin.role],
      ttlSeconds: this.config.ADMIN_ACCESS_TTL_SECONDS,
    });
    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      expiresAt: access.expiresAt.toISOString(),
      admin: toAdminUserDto(admin),
    };
  }

  private totpReplayed(): DomainError {
    return new DomainError(
      IdentityErrors.PC_ADMIN_TOTP_INVALID,
      'This authenticator code was already used; wait for the next one',
    );
  }

  private challengeInvalid(): DomainError {
    return new DomainError(
      IdentityErrors.PC_ADMIN_CHALLENGE_INVALID,
      'The login challenge is invalid, used or expired; log in again',
    );
  }

  private locked(admin: AdminUser, now: Date): DomainError {
    const until = admin.lockedUntil ?? now;
    return new DomainError(
      IdentityErrors.PC_ADMIN_LOGIN_LOCKED,
      'Too many failed logins; the account is locked for a while',
      {
        details: {
          retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
          lockedUntil: until.toISOString(),
        },
      },
    );
  }

  /** Successful login: last login time, failure counter reset, outstanding challenge consumed. */
  private async recordLogin(
    uow: IdentityUow,
    admin: AdminUser,
    now: Date,
    method: LoginMethod,
    ip: string | null | undefined,
  ): Promise<AdminUser> {
    const row = await uow.updateAdmin(admin.id, {
      lastLoginAt: now,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      loginChallengeId: null,
      loginChallengeAttempts: 0,
    });
    await uow.audit({
      actor: { type: 'admin', id: admin.id },
      action: 'admin_user.login',
      entityType: 'admin_user',
      entityId: admin.id,
      after: { method },
      ip: ip ?? null,
    });
    return row;
  }

  /**
   * A failed attempt on a known account: counter + lockout under a row lock, audited in the same
   * transaction (`admin_user.login_failed`, plus `admin_user.login_locked` when it locks).
   */
  private async registerFailure(
    admin: AdminUser,
    reason: FailureReason,
    ip: string | null | undefined,
  ): Promise<void> {
    const now = this.clock.now();
    const update = await this.store.run(async (uow) => {
      const next = await uow.recordAdminLoginFailure(admin.id, now, this.lockPolicy);
      await uow.audit({
        actor: { type: 'admin', id: admin.id },
        action: 'admin_user.login_failed',
        entityType: 'admin_user',
        entityId: admin.id,
        reason,
        after: next
          ? {
              failedLoginCount: next.failedLoginCount,
              lockedUntil: next.lockedUntil ? next.lockedUntil.toISOString() : null,
            }
          : undefined,
        ip: ip ?? null,
      });
      if (next?.lockedNow) {
        await uow.audit({
          actor: { type: 'system', id: ADMIN_LOGIN_GUARD_ACTOR },
          action: 'admin_user.login_locked',
          entityType: 'admin_user',
          entityId: admin.id,
          reason,
          after: {
            failedLoginCount: next.failedLoginCount,
            lockedUntil: next.lockedUntil?.toISOString() ?? null,
          },
          ip: ip ?? null,
        });
      }
      return next;
    });
    if (update?.lockedNow) {
      this.logger.warn(
        `Admin ${admin.id} locked until ${update.lockedUntil?.toISOString() ?? '?'} after ${update.failedLoginCount} failed logins (last: ${reason})`,
      );
    }
    await this.noteFailure(ip, now);
  }

  /** Burst detection per IP network over every failure, known account or not. */
  private async noteFailure(ip: string | null | undefined, now: Date): Promise<void> {
    const key = ipRateLimitKey(ip) ?? 'unknown';
    const { count, burst } = this.bursts.hit(key, now.getTime());
    if (!burst) {
      return;
    }
    const windowSeconds = this.config.ADMIN_LOGIN_BURST_WINDOW_SECONDS;
    this.logger.warn(
      `Burst of failed admin logins from ${key}: ${count} within ${windowSeconds} s (admin_user.login_failed)`,
    );
    await this.store.run((uow) =>
      uow.audit({
        actor: { type: 'system', id: ADMIN_LOGIN_GUARD_ACTOR },
        action: 'admin_user.login_failed_burst',
        entityType: 'admin_user',
        entityId: null,
        after: { network: key, failures: count, windowSeconds },
        ip: ip ?? null,
      }),
    );
  }

  private async auditFailure(
    admin: AdminUser,
    reason: 'inactive',
    ip: string | null | undefined,
  ): Promise<void> {
    await this.store.run((uow) =>
      uow.audit({
        actor: { type: 'admin', id: admin.id },
        action: 'admin_user.login_failed',
        entityType: 'admin_user',
        entityId: admin.id,
        reason,
        ip: ip ?? null,
      }),
    );
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword('portcity-timing-equaliser', this.passwordParams);
    return this.dummyHash;
  }
}
