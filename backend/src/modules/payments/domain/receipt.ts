import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Unambiguous alphabet (no 0/O, 1/I/L) shared with voucher codes. */
const DISPLAY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Short human id for the payment receipt screen and support calls, e.g. `4F7K-2031`:
 * four letters/digits and four digits derived from the payment id (SHA-256), so it is stable
 * and needs no column. Not unique by construction: support searches by it together with the
 * date or the plate; the full id stays the reference.
 */
export function displayNumberOf(paymentId: string): string {
  const digest = createHash('sha256').update(paymentId).digest();
  let letters = '';
  for (let index = 0; index < 4; index += 1) {
    letters += DISPLAY_ALPHABET[(digest[index] ?? 0) % DISPLAY_ALPHABET.length];
  }
  const number = (((digest[4] ?? 0) << 8) | (digest[5] ?? 0)) % 10_000;
  return `${letters}-${String(number).padStart(4, '0')}`;
}

export const OPERATOR_QR_PREFIX = 'PCP1';

export interface OperatorQrFacts {
  paymentId: string;
  sessionId: string;
  /** Exit deadline bought by the payment. */
  paidUntil: Date;
  amountKopecks: number;
}

function signature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22);
}

function body(facts: OperatorQrFacts): string {
  return [
    OPERATOR_QR_PREFIX,
    facts.paymentId,
    facts.sessionId,
    String(Math.floor(facts.paidUntil.getTime() / 1000)),
    String(facts.amountKopecks),
  ].join('.');
}

/**
 * Payload of the QR on the receipt screen that the parking operator's staff (or barrier
 * scanner) can check offline: `PCP1.<paymentId>.<sessionId>.<paidUntilUnix>.<amountKopecks>.<sig>`
 * where `sig` is the first 22 characters of base64url(HMAC-SHA256(secret, everything before it)).
 */
export function signOperatorQr(secret: string, facts: OperatorQrFacts): string {
  const signed = body(facts);
  return `${signed}.${signature(secret, signed)}`;
}

/** Verifies and parses an operator QR payload; null when malformed or not signed with `secret`. */
export function verifyOperatorQr(secret: string, payload: string): OperatorQrFacts | null {
  const parts = payload.split('.');
  if (parts.length !== 6 || parts[0] !== OPERATOR_QR_PREFIX) {
    return null;
  }
  const [, paymentId, sessionId, paidUntilUnix, amount, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = signature(secret, parts.slice(0, 5).join('.'));
  const given = Buffer.from(sig);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return null;
  }
  const seconds = Number(paidUntilUnix);
  const amountKopecks = Number(amount);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(amountKopecks)) {
    return null;
  }
  return { paymentId, sessionId, paidUntil: new Date(seconds * 1000), amountKopecks };
}
