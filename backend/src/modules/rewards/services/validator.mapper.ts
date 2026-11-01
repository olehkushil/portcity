import type { ValidatorDevice } from '@prisma/client';
import type { Page } from '../../../common/pagination/cursor';
import type { ValidatorDeviceDto } from '../dto/admin-validator-device.dto';
import type { ValidatorLogEntryDto, ValidatorLogPageDto } from '../dto/validator.dto';
import type { RedemptionLogWithVoucher } from './rewards.repository';

/** Back-office view of a validator device; the PIN and key hashes never leave the service. */
export function toValidatorDeviceDto(device: ValidatorDevice): ValidatorDeviceDto {
  return {
    id: device.id,
    tenantId: device.tenantId,
    name: device.name,
    active: device.active,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    failedPinAttempts: device.failedPinAttempts,
    pinLockedUntil: device.pinLockedUntil,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

export interface ValidatorLogViewOptions {
  /**
   * True on the device's own log (GET /validator/log): attempts on another tenant's voucher
   * show no voucher id or title. The back office sees everything.
   */
  forDevice?: boolean;
}

/** One redeem attempt as shown on the validator screen and in the back office (no IP). */
export function toValidatorLogEntryDto(
  entry: RedemptionLogWithVoucher,
  options: ValidatorLogViewOptions = {},
): ValidatorLogEntryDto {
  const hideVoucher = options.forDevice === true && entry.outcome === 'wrong_tenant';
  return {
    id: entry.id,
    voucherId: hideVoucher ? null : entry.voucherId,
    voucher:
      entry.voucher && !hideVoucher
        ? { id: entry.voucher.id, title: entry.voucher.title, kind: entry.voucher.kind }
        : null,
    method: entry.method,
    codeTried: entry.codeTried,
    outcome: entry.outcome,
    message: entry.message,
    createdAt: entry.createdAt,
  };
}

export function toValidatorLogPageDto(
  page: Page<RedemptionLogWithVoucher>,
  options: ValidatorLogViewOptions = {},
): ValidatorLogPageDto {
  return {
    items: page.items.map((entry) => toValidatorLogEntryDto(entry, options)),
    nextCursor: page.nextCursor,
  };
}
