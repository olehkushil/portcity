import type { RewardsErrorCode, VoucherStatus } from '../../../common/contracts/rewards';

/**
 * Validator redeem decision (brief sections 6 and 7). Pure: inputs are plain snapshots of the
 * voucher and the validator device, the output is the outcome recorded in
 * voucher_redemption_logs (enum VoucherRedemptionOutcome). The service performs the atomic
 * `UPDATE ... WHERE status = 'active' AND activation_expires_at > now()` only for `redeemed`.
 */

export const REDEEM_OUTCOMES = [
  'redeemed',
  'not_found',
  'not_active',
  'activation_expired',
  'already_redeemed',
  'expired',
  'cancelled',
  'wrong_tenant',
  'device_inactive',
] as const;
export type RedeemOutcome = (typeof REDEEM_OUTCOMES)[number];
export type RedeemFailure = Exclude<RedeemOutcome, 'redeemed'>;

export interface RedeemVoucherSnapshot {
  status: VoucherStatus;
  tenantId: string | null;
  activationExpiresAt: Date | null;
  expiresAt: Date | null;
}

export interface RedeemDeviceSnapshot {
  /** Null for mall-operated devices (information desk), which may redeem any voucher. */
  tenantId: string | null;
  active: boolean;
  revokedAt: Date | null;
}

export function isDeviceOperational(device: RedeemDeviceSnapshot): boolean {
  return device.active && device.revokedAt === null;
}

/**
 * Tenant rule: a mall device redeems everything; a tenant device redeems only vouchers bound
 * to its own tenant (vouchers without a tenant are mall-wide and go to the information desk).
 */
export function deviceMayRedeemTenant(
  device: Pick<RedeemDeviceSnapshot, 'tenantId'>,
  voucherTenantId: string | null,
): boolean {
  return device.tenantId === null || device.tenantId === voucherTenantId;
}

export interface EvaluateRedeemOptions {
  /**
   * Default true: only a live 2-minute activation can be redeemed (code or activation token).
   * False for the static offline QR of tickets and certificates, which needs no activation.
   */
  requireActivation?: boolean;
}

/**
 * The tenant rule is checked before anything about the voucher's state, so a tenant device
 * learns nothing about another tenant's voucher (redeemed, cancelled, expired...): it only ever
 * sees `wrong_tenant`.
 */
export function evaluateRedeem(
  voucher: RedeemVoucherSnapshot | null,
  device: RedeemDeviceSnapshot,
  now: Date,
  options: EvaluateRedeemOptions = {},
): RedeemOutcome {
  if (!isDeviceOperational(device)) {
    return 'device_inactive';
  }
  if (voucher === null) {
    return 'not_found';
  }
  if (!deviceMayRedeemTenant(device, voucher.tenantId)) {
    return 'wrong_tenant';
  }
  switch (voucher.status) {
    case 'redeemed':
      return 'already_redeemed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    default:
      break;
  }
  if (voucher.expiresAt !== null && voucher.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (options.requireActivation === false) {
    return 'redeemed';
  }
  if (voucher.status !== 'active') {
    return 'not_active';
  }
  if (
    voucher.activationExpiresAt === null ||
    voucher.activationExpiresAt.getTime() <= now.getTime()
  ) {
    return 'activation_expired';
  }
  return 'redeemed';
}

export const REDEEM_FAILURE_ERRORS: Readonly<Record<RedeemFailure, RewardsErrorCode>> = {
  not_found: 'PC_VOUCHER_NOT_FOUND',
  not_active: 'PC_VOUCHER_NOT_ACTIVE',
  activation_expired: 'PC_VOUCHER_NOT_ACTIVE',
  already_redeemed: 'PC_VOUCHER_ALREADY_REDEEMED',
  expired: 'PC_VOUCHER_EXPIRED',
  cancelled: 'PC_VOUCHER_FINAL',
  wrong_tenant: 'PC_VOUCHER_WRONG_TENANT',
  device_inactive: 'PC_VALIDATOR_INACTIVE',
};

export const REDEEM_FAILURE_MESSAGES: Readonly<Record<RedeemFailure, string>> = {
  not_found: 'No voucher matches this code or token',
  not_active: 'The voucher has not been activated by the member',
  activation_expired: 'The activation window has lapsed; ask the member to activate again',
  already_redeemed: 'The voucher was already redeemed',
  expired: 'The voucher has expired',
  cancelled: 'The voucher was cancelled',
  wrong_tenant: 'The voucher belongs to another point of redemption',
  device_inactive: 'This validator device is inactive or revoked',
};
