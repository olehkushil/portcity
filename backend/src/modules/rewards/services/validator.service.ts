import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ValidatorDevice, Voucher } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  VALIDATOR_KEY_HEADER,
  VALIDATOR_PIN_HEADER,
  VALIDATOR_SHIFT_HEADER,
} from '../../../common/auth/auth.constants';
import { sha256Hex, verifyPassword } from '../../../common/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import {
  OUTBOX_AGGREGATES,
  REWARD_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import {
  activationTokenHash,
  normalizeActivationCode,
  parseActivationToken,
} from '../domain/activation';
import { type CreatedAtCursor, createdAtCursorOf, isCreatedAtCursor } from '../domain/cursors';
import { RewardsErrors } from '../domain/errors';
import {
  REDEEM_FAILURE_ERRORS,
  REDEEM_FAILURE_MESSAGES,
  type RedeemOutcome,
  evaluateRedeem,
} from '../domain/redeem-rules';
import {
  isStaticQrPayload,
  parseStaticVoucherQr,
  staticQrExp,
  voucherKindHasStaticQr,
} from '../domain/static-qr';
import { VALIDATOR_PIN_MAX_FAILURES, decidePinFailure, isPinLocked } from '../domain/validator-pin';
import { computeShiftWindow, parseShiftToken, signShiftToken } from '../domain/validator-shift';
import { VOUCHER_LIVE_STATUSES } from '../domain/voucher-state';
import { REWARDS_CONFIG, type RewardsConfig } from '../rewards.config';
import { type RedemptionLogWithVoucher, RewardsRepository } from './rewards.repository';
import type { VoucherView } from './voucher.mapper';
import { VoucherService, voucherLifecyclePayload } from './voucher.service';

/** Header names live in src/common/auth/auth.constants.ts (OpenAPI security schemes); re-exported for callers. */
export { VALIDATOR_PIN_HEADER, VALIDATOR_SHIFT_HEADER };

/** How often `lastSeenAt` is written per device (requests in between are not persisted). */
const TOUCH_INTERVAL_MS = 60_000;
const CODE_TRIED_MAX_LENGTH = 16;

/** `key`: only the device key was checked (opening a shift); `shift`: key + shift token. */
export type ValidatorAuthMethod = 'key' | 'shift';

export interface ValidatorPrincipal {
  deviceId: string;
  name: string;
  tenantId: string | null;
  authMethod: ValidatorAuthMethod;
  shiftExpiresAt: Date | null;
}

export interface ValidatorAuthOptions {
  /** When false only the device key is checked (used to open a shift with the PIN). */
  requireShift: boolean;
}

export interface OpenShiftResult {
  shiftToken: string;
  expiresAt: Date;
  device: ValidatorPrincipal;
}

export interface ValidatorRedeemInput {
  code?: string | undefined;
  /** Activation token from the member QR, or the static `PCV1:` QR of a ticket/certificate. */
  token?: string | undefined;
}

export interface ValidatorRedeemResult {
  outcome: 'redeemed';
  voucher: VoucherView;
  redeemedAt: Date;
  device: ValidatorPrincipal;
}

type LocateMode = 'activation' | 'static';

interface Located {
  voucher: Voucher | null;
  codeTried: string | null;
  hint: RedeemOutcome | null;
  mode: LocateMode;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function principalOf(
  device: ValidatorDevice,
  authMethod: ValidatorAuthMethod,
  shiftExpiresAt: Date | null,
): ValidatorPrincipal {
  return {
    deviceId: device.id,
    name: device.name,
    tenantId: device.tenantId,
    authMethod,
    shiftExpiresAt,
  };
}

/**
 * Validator devices at the counter (brief section 8, "validator"): authentication with
 * X-Validator-Key plus a shift token obtained once per shift with the PIN, atomic voucher
 * redemption by code, activation token or the static QR of tickets and certificates, and the
 * per-device redemption log.
 *
 * Hardening: the PIN is accepted only by POST /validator/shift; 5 wrong PINs in a row lock
 * that endpoint for the device for 15 minutes (audited); failures never reveal voucher ids, and
 * a tenant device learns nothing about another tenant's voucher beyond `wrong_tenant`.
 */
@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);
  private readonly lastTouch = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: RewardsRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly vouchers: VoucherService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REWARDS_CONFIG) private readonly rewardsConfig: RewardsConfig,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  private get pepper(): string {
    return this.config.VOUCHER_PEPPER;
  }

  // --- authentication ------------------------------------------------------------------------

  /**
   * Resolves the device from X-Validator-Key, then (unless only the key is required) proves
   * the shift with a valid X-Validator-Shift token. The PIN itself is never accepted here.
   */
  async authenticate(
    headers: IncomingHttpHeaders,
    options: ValidatorAuthOptions,
  ): Promise<ValidatorPrincipal> {
    const device = await this.resolveDevice(headers);
    if (!options.requireShift) {
      return principalOf(device, 'key', null);
    }
    const now = this.clock.now();
    const shift = headerValue(headers, VALIDATOR_SHIFT_HEADER);
    if (shift) {
      const parsed = parseShiftToken(shift, device, this.pepper, now);
      if (!parsed.ok) {
        throw new DomainError(
          RewardsErrors.PC_VALIDATOR_PIN_REQUIRED,
          'Shift token is invalid or expired; open a new shift with the PIN',
          { details: { reason: parsed.reason } },
        );
      }
      return principalOf(device, 'shift', parsed.expiresAt);
    }
    const pinSent = headerValue(headers, VALIDATOR_PIN_HEADER) !== undefined;
    throw new DomainError(
      RewardsErrors.PC_VALIDATOR_PIN_REQUIRED,
      pinSent
        ? `The PIN is accepted only by POST /validator/shift; send the shift token as ${VALIDATOR_SHIFT_HEADER}`
        : `Send the shift token as ${VALIDATOR_SHIFT_HEADER} (POST /validator/shift opens a shift)`,
    );
  }

  /**
   * PIN once per shift: returns a token the device sends as X-Validator-Shift afterwards.
   * Wrong PINs are counted on the device row; the 5th in a row locks shift opening for 15
   * minutes and writes an audit row.
   */
  async openShift(
    deviceId: string,
    pin: string,
    ip: string | null = null,
  ): Promise<OpenShiftResult> {
    const device = await this.requireOperationalDevice(deviceId);
    const now = this.clock.now();
    if (isPinLocked(device, now)) {
      throw this.pinLocked(device.pinLockedUntil as Date);
    }
    if (!(await verifyPassword(pin, device.pinHash))) {
      await this.registerPinFailure(device, now, ip);
    }
    if (device.failedPinAttempts > 0 || device.pinLockedUntil !== null) {
      await this.repo.updateDevice(this.prisma, device.id, {
        failedPinAttempts: 0,
        pinLockedUntil: null,
      });
    }
    const window = computeShiftWindow(now, this.rewardsConfig.VALIDATOR_SHIFT_HOURS);
    const shiftToken = signShiftToken(device.id, window.exp, device.pinHash, this.pepper);
    await this.touch(device.id, now, true);
    return {
      shiftToken,
      expiresAt: window.expiresAt,
      device: principalOf(device, 'shift', window.expiresAt),
    };
  }

  async describe(principal: ValidatorPrincipal): Promise<ValidatorPrincipal> {
    const device = await this.requireOperationalDevice(principal.deviceId);
    await this.touch(device.id, this.clock.now(), false);
    return principalOf(device, principal.authMethod, principal.shiftExpiresAt);
  }

  // --- redemption ----------------------------------------------------------------------------

  /**
   * Redeem by 6-character code, activation token or static QR. Every attempt is written to
   * voucher_redemption_logs; only `redeemed` performs the atomic conditional update and
   * publishes `voucher.redeemed`: activation-based redemption requires `status = active AND
   * activation_expires_at > now`, the static QR of a ticket/certificate requires a live status.
   * Both require `expires_at > now` and succeed once. Failures are thrown after the log row is
   * committed, without voucher ids or other voucher details.
   */
  async redeem(
    principal: ValidatorPrincipal,
    input: ValidatorRedeemInput,
    ip: string | null,
  ): Promise<ValidatorRedeemResult> {
    const now = this.clock.now();
    const device = await this.requireDevice(principal.deviceId);
    const method: 'code' | 'token' = input.token ? 'token' : 'code';
    const { voucher, codeTried, hint, mode } = await this.locate(input, now);
    const requireActivation = mode === 'activation';

    let outcome: RedeemOutcome = evaluateRedeem(voucher, device, now, { requireActivation });
    // A token hint refines the outcome: a correctly signed but expired token reads as a lapsed
    // activation (not "not found"), a token of an earlier activation as "not active". The
    // tenant rule still wins, so a foreign voucher only ever reads as wrong_tenant.
    if (hint && (outcome === 'redeemed' || outcome === 'not_found')) {
      outcome = hint;
    }
    let redeemed: Voucher | null = null;

    await this.prisma.withTx(async (tx) => {
      if (outcome === 'redeemed' && voucher) {
        const changed = await this.repo.updateVoucherIf(
          tx,
          requireActivation
            ? { id: voucher.id, statuses: ['active'], activationLiveAt: now, notExpiredAt: now }
            : { id: voucher.id, statuses: VOUCHER_LIVE_STATUSES, notExpiredAt: now },
          {
            status: 'redeemed',
            redeemedAt: now,
            redeemedByDeviceId: device.id,
            redeemedByTenantId: device.tenantId,
            ...(requireActivation ? {} : { code: null, tokenHash: null }),
          },
        );
        if (changed === 1) {
          redeemed = (await this.repo.findVoucherById(tx, voucher.id)) ?? {
            ...voucher,
            status: 'redeemed' as const,
            redeemedAt: now,
            redeemedByDeviceId: device.id,
            redeemedByTenantId: device.tenantId,
          };
          await this.outbox.publish(
            tx,
            buildOutboxEvent(REWARD_EVENTS.voucherRedeemed, OUTBOX_AGGREGATES.voucher, voucher.id, {
              ...voucherLifecyclePayload(redeemed),
              redeemedAt: now.toISOString(),
              redeemedByDeviceId: device.id,
              redeemedByTenantId: device.tenantId,
            }),
          );
        } else {
          // Lost a race against a concurrent redeem or the sweep: re-evaluate the fresh row.
          const fresh = await this.repo.findVoucherById(tx, voucher.id);
          const reevaluated = evaluateRedeem(fresh, device, now, { requireActivation });
          outcome = reevaluated === 'redeemed' ? 'already_redeemed' : reevaluated;
        }
      }
      await this.repo.createRedemptionLog(tx, {
        id: uuidv7(),
        voucherId: voucher?.id ?? null,
        validatorDeviceId: device.id,
        method,
        codeTried,
        outcome,
        message: outcome === 'redeemed' ? null : REDEEM_FAILURE_MESSAGES[outcome],
        ip,
        createdAt: now,
      });
    });
    await this.touch(device.id, now, false);

    if (outcome !== 'redeemed' || !redeemed) {
      const failure = outcome === 'redeemed' ? 'already_redeemed' : outcome;
      // No voucher id or voucher data in the problem document: the code or QR could belong to
      // another tenant, and ids are not for the counter screen anyway.
      throw new DomainError(
        RewardsErrors[REDEEM_FAILURE_ERRORS[failure]],
        REDEEM_FAILURE_MESSAGES[failure],
        { details: { outcome: failure } },
      );
    }
    return {
      outcome: 'redeemed',
      voucher: await this.vouchers.decorateOne(this.vouchers.summarize(redeemed, now)),
      redeemedAt: now,
      device: principal,
    };
  }

  private async locate(input: ValidatorRedeemInput, now: Date): Promise<Located> {
    if (input.token && isStaticQrPayload(input.token)) {
      return this.locateStatic(input.token, now);
    }
    if (input.token) {
      const parsed = parseActivationToken(input.token, this.pepper, now);
      if (!parsed.ok) {
        return {
          voucher: null,
          codeTried: null,
          hint: parsed.reason === 'expired' ? 'activation_expired' : null,
          mode: 'activation',
        };
      }
      const voucher = await this.repo.findVoucherById(this.prisma, parsed.subject);
      if (voucher && voucher.tokenHash !== activationTokenHash(input.token, this.pepper)) {
        // A token from an earlier activation of the same voucher.
        return { voucher, codeTried: null, hint: 'not_active', mode: 'activation' };
      }
      return { voucher, codeTried: null, hint: null, mode: 'activation' };
    }
    const raw = (input.code ?? '').trim();
    const codeTried = raw.slice(0, CODE_TRIED_MAX_LENGTH) || null;
    const code = normalizeActivationCode(raw);
    if (!code) {
      return { voucher: null, codeTried, hint: null, mode: 'activation' };
    }
    const voucher = await this.repo.findLiveVoucherByCode(this.prisma, code);
    return { voucher, codeTried, hint: null, mode: 'activation' };
  }

  /**
   * Static QR of a ticket or certificate: valid signature, not past its exp, bound to the
   * voucher's current expiresAt (a changed expiry invalidates old codes) and of a static kind.
   */
  private async locateStatic(payload: string, now: Date): Promise<Located> {
    const parsed = parseStaticVoucherQr(payload, this.pepper, now);
    if (!parsed.ok) {
      return {
        voucher: null,
        codeTried: null,
        hint: parsed.reason === 'expired' ? 'expired' : null,
        mode: 'static',
      };
    }
    const voucher = await this.repo.findVoucherById(this.prisma, parsed.voucherId);
    if (
      !voucher ||
      !voucherKindHasStaticQr(voucher.kind) ||
      staticQrExp(voucher.expiresAt) !== parsed.exp
    ) {
      return { voucher: null, codeTried: null, hint: null, mode: 'static' };
    }
    return { voucher, codeTried: null, hint: null, mode: 'static' };
  }

  // --- log -----------------------------------------------------------------------------------

  async listLog(
    deviceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<RedemptionLogWithVoucher>> {
    const decoded = decodeCursor<CreatedAtCursor>(cursor, isCreatedAtCursor);
    const rows = await this.repo.listRedemptionLogs(
      this.prisma,
      { deviceId },
      { cursor: decoded, limit },
    );
    return toPage(rows, limit, createdAtCursorOf);
  }

  // --- internals -----------------------------------------------------------------------------

  private async resolveDevice(headers: IncomingHttpHeaders): Promise<ValidatorDevice> {
    const key = headerValue(headers, VALIDATOR_KEY_HEADER);
    if (!key) {
      throw new DomainError(
        RewardsErrors.PC_VALIDATOR_UNAUTHORIZED,
        `${VALIDATOR_KEY_HEADER} header is required`,
      );
    }
    const device = await this.repo.findDeviceByKeyHash(this.prisma, sha256Hex(key));
    if (!device) {
      throw new DomainError(
        RewardsErrors.PC_VALIDATOR_UNAUTHORIZED,
        'Unknown validator device key',
      );
    }
    return this.assertOperational(device);
  }

  private async requireDevice(deviceId: string): Promise<ValidatorDevice> {
    const device = await this.repo.findDeviceById(this.prisma, deviceId);
    if (!device) {
      throw new DomainError(
        RewardsErrors.PC_VALIDATOR_UNAUTHORIZED,
        'Validator device no longer exists',
      );
    }
    return device;
  }

  private async requireOperationalDevice(deviceId: string): Promise<ValidatorDevice> {
    return this.assertOperational(await this.requireDevice(deviceId));
  }

  private assertOperational(device: ValidatorDevice): ValidatorDevice {
    if (!device.active || device.revokedAt !== null) {
      throw new DomainError(
        RewardsErrors.PC_VALIDATOR_INACTIVE,
        `Validator device "${device.name}" is inactive`,
        {
          details: { deviceId: device.id, revokedAt: device.revokedAt },
        },
      );
    }
    return device;
  }

  /**
   * Counts a wrong PIN (atomic increment, committed even though the request fails) and throws:
   * PC_VALIDATOR_PIN_INVALID with the attempts left, or PC_VALIDATOR_PIN_LOCKED when this was
   * the 5th failure in a row (lock + audit row in one transaction).
   */
  private async registerPinFailure(
    device: ValidatorDevice,
    now: Date,
    ip: string | null,
  ): Promise<never> {
    const attempts = await this.repo.incrementPinFailures(this.prisma, device.id);
    const decision = decidePinFailure(attempts, now);
    if (!decision.lock) {
      throw new DomainError(RewardsErrors.PC_VALIDATOR_PIN_INVALID, 'Validator PIN is invalid', {
        details: { attemptsLeft: Math.max(VALIDATOR_PIN_MAX_FAILURES - attempts, 0) },
      });
    }
    await this.prisma.withTx(async (tx) => {
      await this.repo.updateDevice(tx, device.id, {
        failedPinAttempts: decision.failedPinAttempts,
        pinLockedUntil: decision.pinLockedUntil,
      });
      await this.audit.audit(
        {
          actor: { type: 'system', id: 'validator' },
          action: 'validator_device.pin_locked',
          entityType: 'validator_device',
          entityId: device.id,
          after: {
            failedPinAttempts: attempts,
            pinLockedUntil: decision.pinLockedUntil.toISOString(),
          },
          reason: `${VALIDATOR_PIN_MAX_FAILURES} wrong PINs in a row`,
          ip,
        },
        tx,
      );
    });
    this.logger.warn(
      `Validator ${device.id}: ${attempts} wrong PINs, shift opening locked until ${decision.pinLockedUntil.toISOString()}`,
    );
    throw this.pinLocked(decision.pinLockedUntil);
  }

  private pinLocked(lockedUntil: Date): DomainError {
    return new DomainError(
      RewardsErrors.PC_VALIDATOR_PIN_LOCKED,
      'Too many wrong PINs; try again later',
      { details: { lockedUntil: lockedUntil.toISOString() } },
    );
  }

  /** Persists `lastSeenAt` at most once per TOUCH_INTERVAL_MS per device. */
  private async touch(deviceId: string, now: Date, force: boolean): Promise<void> {
    const last = this.lastTouch.get(deviceId) ?? 0;
    if (!force && now.getTime() - last < TOUCH_INTERVAL_MS) {
      return;
    }
    this.lastTouch.set(deviceId, now.getTime());
    try {
      await this.repo.updateDevice(this.prisma, deviceId, { lastSeenAt: now });
    } catch (error) {
      this.logger.warn(`Could not update lastSeenAt for validator ${deviceId}: ${String(error)}`);
    }
  }
}
