/**
 * Rewards contract: vouchers as a service for other modules.
 * Implemented by `src/modules/rewards`, provided under VOUCHER_ISSUER_PORT.
 * Consumers: promos (coupon vouchers on claim, ticket vouchers on event registration),
 * admin (admin-issued vouchers, reports). The reward catalogue, redemptions, activation and
 * the validator API are HTTP endpoints hosted by the rewards module itself.
 */
import type { ActorRef, DateRange, Tx, Uuid } from './shared';

export const VOUCHER_ISSUER_PORT = Symbol('VOUCHER_ISSUER_PORT');

export const REWARD_KINDS = ['parking_hour', 'partner', 'certificate', 'gift', 'cinema'] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

export const REDEMPTION_STATUSES = ['created', 'issued', 'cancelled', 'refunded'] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

export const VOUCHER_KINDS = ['coupon', 'reward', 'ticket', 'certificate'] as const;
export type VoucherKind = (typeof VOUCHER_KINDS)[number];

export const VOUCHER_STATUSES = ['issued', 'active', 'redeemed', 'expired', 'cancelled'] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

export const VOUCHER_SOURCE_TYPES = ['redemption', 'promo', 'event', 'admin'] as const;
export type VoucherSourceType = (typeof VOUCHER_SOURCE_TYPES)[number];

/** Activation (brief section 7): 6-character code, unambiguous alphabet, 120-second window. */
export const VOUCHER_CODE_LENGTH = 6;
export const VOUCHER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const VOUCHER_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
export const VOUCHER_ACTIVATION_SECONDS = 120;

export interface VoucherSummary {
  id: Uuid;
  userId: Uuid;
  kind: VoucherKind;
  title: string;
  subtitle: string | null;
  tenantId: Uuid | null;
  status: VoucherStatus;
  /** Present only while the voucher is `active`. */
  code: string | null;
  activatedAt: Date | null;
  activationExpiresAt: Date | null;
  redeemedAt: Date | null;
  redeemedByTenantId: Uuid | null;
  /** Hard expiry; null means no expiry. */
  expiresAt: Date | null;
  sourceType: VoucherSourceType;
  sourceId: Uuid | null;
  meta: Record<string, unknown>;
  createdAt: Date;
  /**
   * 8-digit number printed under the QR for people ("№ 4821 0937"), stable per voucher.
   * Not a secret and not accepted for redemption. Optional so fakes of the port stay valid.
   */
  displayNumber?: string;
  /**
   * Static offline QR of tickets and certificates while they are live: `PCV1:<signed token>`
   * binding the voucher id and expiresAt (valid until expiresAt), redeemable once by a validator
   * without activation. Null for other kinds and for final vouchers.
   */
  qrPayload?: string | null;
  /** Storage key of the voucher picture (S3_PUBLIC_BASE_URL + key is the public URL). */
  imageKey?: string | null;
}

/** Voucher kinds that carry a static offline QR instead of the 2-minute activation. */
export const STATIC_QR_VOUCHER_KINDS: readonly VoucherKind[] = ['ticket', 'certificate'];
export const STATIC_QR_PREFIX = 'PCV1:';

export interface IssueVoucherInput {
  userId: Uuid;
  kind: VoucherKind;
  title: string;
  subtitle?: string;
  tenantId?: Uuid;
  /** Null or omitted means no hard expiry. */
  expiresAt?: Date | null;
  sourceType: VoucherSourceType;
  /** Id of the promo claim, event registration or admin action. */
  sourceId: Uuid;
  /** Free-form JSON shown to the validator and the app (discountText, eventId, persons, ...). */
  meta?: Record<string, unknown>;
  /** Storage key of the picture shown in the wallet (promo or event image). */
  imageKey?: string | null;
}

export interface CancelVoucherInput {
  voucherId: Uuid;
  reason: string;
  actor: ActorRef;
  /** For reward vouchers: reverse the spend transaction through the club ledger (default true). */
  refundPoints?: boolean;
}

export interface VoucherDailyStats {
  issued: number;
  redeemed: number;
  /** Vouchers in `issued` or `active` state at the end of the range. */
  live: number;
}

export interface VoucherIssuerPort {
  /** Idempotent per (sourceType, sourceId, kind): a repeated call returns the existing voucher. */
  issue(input: IssueVoucherInput, tx?: Tx): Promise<VoucherSummary>;
  /** issued|active -> cancelled. Throws PC_VOUCHER_NOT_FOUND / PC_VOUCHER_FINAL otherwise. */
  cancel(input: CancelVoucherInput, tx?: Tx): Promise<VoucherSummary>;
  getVoucher(voucherId: Uuid): Promise<VoucherSummary | null>;
  /** Vouchers issued for a source (e.g. all tickets of an event registration). */
  listBySource(sourceType: VoucherSourceType, sourceId: Uuid): Promise<VoucherSummary[]>;
  getDailyStats(range: DateRange): Promise<VoucherDailyStats>;
}

export const REWARDS_ERROR_CODES = [
  'PC_REWARD_NOT_FOUND',
  'PC_REWARD_INACTIVE',
  'PC_REWARD_OUT_OF_STOCK',
  'PC_REWARD_LIMIT_REACHED',
  'PC_VOUCHER_NOT_FOUND',
  'PC_VOUCHER_NOT_ACTIVE',
  'PC_VOUCHER_EXPIRED',
  'PC_VOUCHER_ALREADY_REDEEMED',
  'PC_VOUCHER_FINAL',
  'PC_VOUCHER_WRONG_TENANT',
  'PC_VOUCHER_CODE_EXHAUSTED',
  'PC_VALIDATOR_UNAUTHORIZED',
  'PC_VALIDATOR_PIN_REQUIRED',
  'PC_VALIDATOR_PIN_INVALID',
  'PC_VALIDATOR_INACTIVE',
  /** 404: unknown validator device in the back office. */
  'PC_VALIDATOR_NOT_FOUND',
  /** 429: too many wrong PINs; opening a shift is locked for a while (details.lockedUntil). */
  'PC_VALIDATOR_PIN_LOCKED',
] as const;
export type RewardsErrorCode = (typeof REWARDS_ERROR_CODES)[number];
