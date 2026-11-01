import { hmacSha256Hex, safeEqual } from '../../../common/auth/crypto';
import { MEMBER_QR_PATTERN, MEMBER_QR_PREFIX } from '../../../common/contracts/club';
import { MEMBER_CODE_PATTERN } from '../../../common/contracts/identity';

/**
 * Club card QR payload `PC1:<memberCode>:<hmac8>` (brief section 8): a static, long-lived code
 * that identifies the member offline; hmac8 = first 8 hex chars of HMAC-SHA256(secret, memberCode)
 * lets a validator reject hand-typed codes without a round trip.
 */
export const MEMBER_QR_HMAC_LENGTH = 8;

export function memberQrHmac(secret: string, memberCode: string): string {
  return hmacSha256Hex(secret, memberCode).slice(0, MEMBER_QR_HMAC_LENGTH);
}

export function buildMemberQrPayload(secret: string, memberCode: string): string {
  if (!MEMBER_CODE_PATTERN.test(memberCode)) {
    throw new RangeError(`Member code must be ${MEMBER_CODE_PATTERN.source}, got "${memberCode}"`);
  }
  return `${MEMBER_QR_PREFIX}:${memberCode}:${memberQrHmac(secret, memberCode)}`;
}

/** Returns the member code when the payload is well-formed and its checksum matches, else null. */
export function parseMemberQrPayload(
  secret: string,
  payload: string,
): { memberCode: string } | null {
  const match = MEMBER_QR_PATTERN.exec(payload.trim());
  const memberCode = match?.[1];
  const hmac = match?.[2];
  if (!memberCode || !hmac) {
    return null;
  }
  return safeEqual(hmac, memberQrHmac(secret, memberCode)) ? { memberCode } : null;
}
