import { signActivationToken } from './activation';
import {
  STATIC_QR_NO_EXPIRY_EXP,
  isStaticQrPayload,
  parseStaticVoucherQr,
  signStaticVoucherQr,
  staticQrExp,
  voucherDisplayNumber,
  voucherKindHasStaticQr,
} from './static-qr';

const SECRET = 'test-voucher-pepper-0123456789';
const VOUCHER = '0192f3a0-6c3e-7d2a-9c1b-00000000c0de';
const NOW = new Date('2026-11-01T10:00:00.000Z');
const EXPIRES = new Date('2026-11-08T18:00:00.000Z');

describe('static voucher QR', () => {
  it('signs and parses a payload bound to the voucher id and expiresAt', () => {
    const payload = signStaticVoucherQr(VOUCHER, EXPIRES, SECRET);
    expect(payload.startsWith('PCV1:')).toBe(true);
    expect(isStaticQrPayload(payload)).toBe(true);
    expect(parseStaticVoucherQr(payload, SECRET, NOW)).toEqual({
      ok: true,
      voucherId: VOUCHER,
      exp: staticQrExp(EXPIRES),
    });
    // Deterministic: the wallet can show it offline and it never changes for the voucher.
    expect(signStaticVoucherQr(VOUCHER, EXPIRES, SECRET)).toBe(payload);
  });

  it('is valid until expiresAt', () => {
    const payload = signStaticVoucherQr(VOUCHER, EXPIRES, SECRET);
    expect(parseStaticVoucherQr(payload, SECRET, new Date(EXPIRES.getTime() - 1000)).ok).toBe(true);
    expect(parseStaticVoucherQr(payload, SECRET, EXPIRES)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('uses a far-future exp for vouchers without an expiry', () => {
    expect(staticQrExp(null)).toBe(STATIC_QR_NO_EXPIRY_EXP);
    const payload = signStaticVoucherQr(VOUCHER, null, SECRET);
    expect(parseStaticVoucherQr(payload, SECRET, NOW)).toMatchObject({
      ok: true,
      exp: STATIC_QR_NO_EXPIRY_EXP,
    });
  });

  it.each([
    ['another secret', () => signStaticVoucherQr(VOUCHER, EXPIRES, 'other-secret-0123456789')],
    ['a tampered token', () => `${signStaticVoucherQr(VOUCHER, EXPIRES, SECRET).slice(0, -2)}xx`],
  ])('rejects %s', (_name, make) => {
    expect(parseStaticVoucherQr(make(), SECRET, NOW)).toMatchObject({ ok: false });
  });

  it('is never confused with an activation token', () => {
    const activation = signActivationToken(VOUCHER, Math.floor(EXPIRES.getTime() / 1000), SECRET);
    expect(isStaticQrPayload(activation)).toBe(false);
    expect(parseStaticVoucherQr(`PCV1:${activation}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(parseStaticVoucherQr('garbage', SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it.each([
    ['ticket', true],
    ['certificate', true],
    ['reward', false],
    ['coupon', false],
  ] as const)('kind %s has a static QR: %p', (kind, expected) => {
    expect(voucherKindHasStaticQr(kind)).toBe(expected);
  });
});

describe('voucherDisplayNumber', () => {
  it('is 8 digits, stable per voucher and differs between vouchers', () => {
    const number = voucherDisplayNumber(VOUCHER);
    expect(number).toMatch(/^\d{8}$/);
    expect(voucherDisplayNumber(VOUCHER)).toBe(number);
    expect(voucherDisplayNumber('0192f3a0-6c3e-7d2a-9c1b-00000000c0df')).not.toBe(number);
  });
});
