import { signExpiringToken, toUnixSeconds } from './signed-token';
import {
  SHIFT_TOKEN_KIND,
  computeShiftWindow,
  parseShiftToken,
  pinFingerprint,
  signShiftToken,
} from './validator-shift';

const SECRET = 'voucher-pepper-for-tests';
const NOW = new Date('2026-11-01T08:00:00.000Z');
const DEVICE = { id: 'device-1', pinHash: '$scrypt$ln=10,r=8,p=1$c2FsdA==$aGFzaA==' };

describe('pinFingerprint', () => {
  it('is a short stable hex digest that changes with the hash', () => {
    const fingerprint = pinFingerprint(DEVICE.pinHash);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(pinFingerprint(DEVICE.pinHash)).toBe(fingerprint);
    expect(pinFingerprint(`${DEVICE.pinHash}x`)).not.toBe(fingerprint);
    expect(fingerprint).not.toContain(DEVICE.pinHash);
  });
});

describe('computeShiftWindow', () => {
  it.each([
    [12, '2026-11-01T20:00:00.000Z'],
    [1, '2026-11-01T09:00:00.000Z'],
    [0.5, '2026-11-01T08:30:00.000Z'],
    [48, '2026-11-03T08:00:00.000Z'],
  ])('%p hours -> %s', (hours, end) => {
    const window = computeShiftWindow(NOW, hours);
    expect(window.openedAt).toEqual(NOW);
    expect(window.expiresAt.toISOString()).toBe(end);
    expect(window.exp).toBe(toUnixSeconds(window.expiresAt));
  });

  it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p hours', (hours) => {
    expect(() => computeShiftWindow(NOW, hours)).toThrow();
  });
});

describe('shift tokens', () => {
  const window = computeShiftWindow(NOW, 12);
  const token = signShiftToken(DEVICE.id, window.exp, DEVICE.pinHash, SECRET);

  it('accepts the token for the same device and PIN hash', () => {
    expect(parseShiftToken(token, DEVICE, SECRET, NOW)).toEqual({
      ok: true,
      deviceId: DEVICE.id,
      expiresAt: window.expiresAt,
    });
  });

  it.each([
    ['another device', () => token, { ...DEVICE, id: 'device-2' }, SECRET, NOW, 'wrong_device'],
    [
      'changed PIN closes the shift',
      () => token,
      { ...DEVICE, pinHash: 'other-hash' },
      SECRET,
      NOW,
      'bad_signature',
    ],
    ['another pepper', () => token, DEVICE, 'other-secret', NOW, 'bad_signature'],
    ['shift over', () => token, DEVICE, SECRET, window.expiresAt, 'expired'],
    ['garbage', () => 'garbage!', DEVICE, SECRET, NOW, 'malformed'],
    [
      'activation token presented as shift token',
      () =>
        signExpiringToken({
          kind: 'voucher-activation',
          subject: DEVICE.id,
          exp: window.exp,
          secret: SECRET,
        }),
      DEVICE,
      SECRET,
      NOW,
      'bad_signature',
    ],
  ])('rejects %s', (_name, tokenOf, device, secret, now, reason) => {
    expect(parseShiftToken(tokenOf(), device, secret, now)).toEqual({ ok: false, reason });
  });

  it('wrong device is detected only after a valid signature (token of device-2 for device-2 pin)', () => {
    const other = signShiftToken('device-2', window.exp, DEVICE.pinHash, SECRET);
    expect(parseShiftToken(other, DEVICE, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'wrong_device',
    });
  });

  it('uses a dedicated token kind', () => {
    expect(SHIFT_TOKEN_KIND).toBe('validator-shift');
  });
});
