import { sha256Hex } from '../../../common/auth/crypto';
import {
  STATIC_QR_PREFIX,
  STATIC_QR_VOUCHER_KINDS,
  type VoucherKind,
} from '../../../common/contracts/rewards';
import { parseExpiringToken, signExpiringToken, toUnixSeconds } from './signed-token';

/**
 * Static offline QR of tickets and certificates (finding 5): the wallet shows it without a
 * network round trip and without the 2-minute activation. Payload `PCV1:<token>` where token is
 * base64url(voucherId.exp.hmac) signed with VOUCHER_PEPPER under its own kind, so it can never be
 * confused with an activation token. `exp` is the voucher's own expiresAt, which the validator
 * compares with the stored value (a changed expiry invalidates old QR codes); vouchers without
 * an expiry use a far-future sentinel. Redemption stays single-use and atomic in the service.
 */

export const STATIC_QR_TOKEN_KIND = 'voucher-static-qr';

/** exp used for vouchers without a hard expiry: 3000-01-01T00:00:00Z. */
export const STATIC_QR_NO_EXPIRY_EXP = 32_503_680_000;

export function voucherKindHasStaticQr(kind: VoucherKind): boolean {
  return STATIC_QR_VOUCHER_KINDS.includes(kind);
}

export function staticQrExp(expiresAt: Date | null): number {
  return expiresAt ? toUnixSeconds(expiresAt) : STATIC_QR_NO_EXPIRY_EXP;
}

export function signStaticVoucherQr(
  voucherId: string,
  expiresAt: Date | null,
  secret: string,
): string {
  const token = signExpiringToken({
    kind: STATIC_QR_TOKEN_KIND,
    subject: voucherId,
    exp: staticQrExp(expiresAt),
    secret,
  });
  return `${STATIC_QR_PREFIX}${token}`;
}

export function isStaticQrPayload(payload: string): boolean {
  return typeof payload === 'string' && payload.startsWith(STATIC_QR_PREFIX);
}

export type ParsedStaticQr =
  | { ok: true; voucherId: string; exp: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/** Verifies prefix, signature and expiry; the caller still checks exp against the voucher row. */
export function parseStaticVoucherQr(payload: string, secret: string, now: Date): ParsedStaticQr {
  if (!isStaticQrPayload(payload)) {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = parseExpiringToken(payload.slice(STATIC_QR_PREFIX.length), {
    kind: STATIC_QR_TOKEN_KIND,
    secret,
    now,
  });
  if (!parsed.ok) {
    return parsed;
  }
  return { ok: true, voucherId: parsed.subject, exp: parsed.exp };
}

/**
 * Human number shown under the QR: 8 digits derived from the voucher id (stable for the life of
 * the voucher, independent of secrets). Display only: it is not unique by construction and is
 * never accepted for redemption.
 */
export function voucherDisplayNumber(voucherId: string): string {
  const digest = sha256Hex(`voucher-display-number:${voucherId}`);
  const value = BigInt(`0x${digest.slice(0, 15)}`) % 100_000_000n;
  return value.toString().padStart(8, '0');
}
