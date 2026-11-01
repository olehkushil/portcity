import { sha256Hex } from '../../../common/auth/crypto';
import {
  type ParsedSignedToken,
  parseExpiringToken,
  signExpiringToken,
  toUnixSeconds,
} from './signed-token';

/**
 * Validator shift tokens: after a cashier enters the shift PIN once, the device receives a
 * signed token base64url(deviceId.exp.hmac) that replaces the PIN for the rest of the shift.
 * The signature binds a fingerprint of the current PIN hash, so changing the PIN closes every
 * open shift; revoking the device closes them too because the guard re-reads the device row.
 */

export const SHIFT_TOKEN_KIND = 'validator-shift';

/** Short stable fingerprint of the stored PIN hash (never the PIN itself). */
export function pinFingerprint(pinHash: string): string {
  return sha256Hex(pinHash).slice(0, 16);
}

export interface ShiftWindow {
  openedAt: Date;
  expiresAt: Date;
  exp: number;
}

export function computeShiftWindow(now: Date, hours: number): ShiftWindow {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('Shift length must be a positive number of hours');
  }
  const exp = toUnixSeconds(now) + Math.round(hours * 3600);
  return { openedAt: now, expiresAt: new Date(exp * 1000), exp };
}

export function signShiftToken(
  deviceId: string,
  exp: number,
  pinHash: string,
  secret: string,
): string {
  return signExpiringToken({
    kind: SHIFT_TOKEN_KIND,
    subject: deviceId,
    exp,
    secret,
    extra: [pinFingerprint(pinHash)],
  });
}

export type ShiftTokenFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_device';

export type ParsedShiftToken =
  { ok: true; deviceId: string; expiresAt: Date } | { ok: false; reason: ShiftTokenFailure };

/** Verifies the token for one specific device (the one identified by X-Validator-Key). */
export function parseShiftToken(
  token: string,
  device: { id: string; pinHash: string },
  secret: string,
  now: Date,
): ParsedShiftToken {
  const parsed: ParsedSignedToken = parseExpiringToken(token, {
    kind: SHIFT_TOKEN_KIND,
    secret,
    now,
    extra: [pinFingerprint(device.pinHash)],
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.subject !== device.id) {
    return { ok: false, reason: 'wrong_device' };
  }
  return { ok: true, deviceId: parsed.subject, expiresAt: parsed.expiresAt };
}
