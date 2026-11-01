import {
  REDEEM_FAILURE_ERRORS,
  REDEEM_FAILURE_MESSAGES,
  REDEEM_OUTCOMES,
  type RedeemDeviceSnapshot,
  type RedeemOutcome,
  type RedeemVoucherSnapshot,
  deviceMayRedeemTenant,
  evaluateRedeem,
  isDeviceOperational,
} from './redeem-rules';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const at = (offsetSeconds: number): Date => new Date(NOW.getTime() + offsetSeconds * 1000);
const TENANT = 'tenant-aroma';
const OTHER = 'tenant-intertop';

const activeVoucher: RedeemVoucherSnapshot = {
  status: 'active',
  tenantId: TENANT,
  activationExpiresAt: at(60),
  expiresAt: at(86_400),
};
const tenantDevice: RedeemDeviceSnapshot = { tenantId: TENANT, active: true, revokedAt: null };
const mallDevice: RedeemDeviceSnapshot = { tenantId: null, active: true, revokedAt: null };

describe('evaluateRedeem', () => {
  const cases: Array<[string, RedeemVoucherSnapshot | null, RedeemDeviceSnapshot, RedeemOutcome]> =
    [
      ['active voucher at its tenant', activeVoucher, tenantDevice, 'redeemed'],
      ['active voucher at a mall device', activeVoucher, mallDevice, 'redeemed'],
      [
        'mall-wide voucher at a mall device',
        { ...activeVoucher, tenantId: null },
        mallDevice,
        'redeemed',
      ],
      ['no hard expiry', { ...activeVoucher, expiresAt: null }, tenantDevice, 'redeemed'],
      ['inactive device', activeVoucher, { ...tenantDevice, active: false }, 'device_inactive'],
      ['revoked device', activeVoucher, { ...tenantDevice, revokedAt: at(-60) }, 'device_inactive'],
      [
        'inactive device beats unknown voucher',
        null,
        { ...tenantDevice, active: false },
        'device_inactive',
      ],
      ['unknown voucher', null, tenantDevice, 'not_found'],
      [
        'already redeemed',
        { ...activeVoucher, status: 'redeemed' },
        tenantDevice,
        'already_redeemed',
      ],
      ['cancelled', { ...activeVoucher, status: 'cancelled' }, tenantDevice, 'cancelled'],
      ['expired status', { ...activeVoucher, status: 'expired' }, tenantDevice, 'expired'],
      [
        'past expiresAt while still active',
        { ...activeVoucher, expiresAt: at(-1) },
        tenantDevice,
        'expired',
      ],
      ['exactly at expiresAt', { ...activeVoucher, expiresAt: at(0) }, tenantDevice, 'expired'],
      [
        'another tenant device',
        activeVoucher,
        { ...tenantDevice, tenantId: OTHER },
        'wrong_tenant',
      ],
      [
        'mall-wide voucher at a tenant device',
        { ...activeVoucher, tenantId: null },
        tenantDevice,
        'wrong_tenant',
      ],
      [
        'issued, never activated',
        { ...activeVoucher, status: 'issued', activationExpiresAt: null },
        tenantDevice,
        'not_active',
      ],
      [
        'wrong tenant is reported before not activated',
        { ...activeVoucher, status: 'issued' },
        { ...tenantDevice, tenantId: OTHER },
        'wrong_tenant',
      ],
      [
        'activation lapsed',
        { ...activeVoucher, activationExpiresAt: at(-1) },
        tenantDevice,
        'activation_expired',
      ],
      [
        'activation ends exactly now',
        { ...activeVoucher, activationExpiresAt: at(0) },
        tenantDevice,
        'activation_expired',
      ],
      [
        'active without window end',
        { ...activeVoucher, activationExpiresAt: null },
        tenantDevice,
        'activation_expired',
      ],
    ];

  it.each(cases)('%s -> %s', (_name, voucher, device, expected) => {
    expect(evaluateRedeem(voucher, device, NOW)).toBe(expected);
  });

  const foreignDevice: RedeemDeviceSnapshot = { ...tenantDevice, tenantId: OTHER };
  it.each<[string, RedeemVoucherSnapshot]>([
    ['redeemed', { ...activeVoucher, status: 'redeemed' }],
    ['cancelled', { ...activeVoucher, status: 'cancelled' }],
    ['expired', { ...activeVoucher, status: 'expired' }],
    ['past expiresAt', { ...activeVoucher, expiresAt: at(-1) }],
    ['lapsed activation', { ...activeVoucher, activationExpiresAt: at(-1) }],
  ])(
    'a %s voucher of another tenant only reads as wrong_tenant (no state leak)',
    (_name, voucher) => {
      expect(evaluateRedeem(voucher, foreignDevice, NOW)).toBe('wrong_tenant');
    },
  );

  describe('static QR (requireActivation: false)', () => {
    const issued: RedeemVoucherSnapshot = {
      status: 'issued',
      tenantId: TENANT,
      activationExpiresAt: null,
      expiresAt: at(86_400),
    };
    const options = { requireActivation: false };

    it.each<[string, RedeemVoucherSnapshot, RedeemDeviceSnapshot, RedeemOutcome]>([
      ['issued, never activated', issued, tenantDevice, 'redeemed'],
      [
        'active with a lapsed window',
        { ...activeVoucher, activationExpiresAt: at(-1) },
        tenantDevice,
        'redeemed',
      ],
      ['already redeemed', { ...issued, status: 'redeemed' }, tenantDevice, 'already_redeemed'],
      ['cancelled', { ...issued, status: 'cancelled' }, tenantDevice, 'cancelled'],
      ['past expiresAt', { ...issued, expiresAt: at(0) }, tenantDevice, 'expired'],
      ['another tenant', issued, foreignDevice, 'wrong_tenant'],
      ['no expiry at a mall device', { ...issued, expiresAt: null }, mallDevice, 'redeemed'],
    ])('%s -> %s', (_name, voucher, device, expected) => {
      expect(evaluateRedeem(voucher, device, NOW, options)).toBe(expected);
    });
  });
});

describe('device helpers', () => {
  it.each([
    [{ active: true, revokedAt: null, tenantId: null }, true],
    [{ active: false, revokedAt: null, tenantId: null }, false],
    [{ active: true, revokedAt: NOW, tenantId: null }, false],
  ])('isDeviceOperational(%j) = %p', (device, expected) => {
    expect(isDeviceOperational(device)).toBe(expected);
  });

  it.each([
    [null, TENANT, true],
    [null, null, true],
    [TENANT, TENANT, true],
    [TENANT, OTHER, false],
    [TENANT, null, false],
  ])(
    'device tenant %p may redeem voucher tenant %p: %p',
    (deviceTenant, voucherTenant, expected) => {
      expect(deviceMayRedeemTenant({ tenantId: deviceTenant }, voucherTenant)).toBe(expected);
    },
  );
});

describe('failure tables', () => {
  const failures = REDEEM_OUTCOMES.filter((outcome) => outcome !== 'redeemed');

  it.each(failures)('%s has an error code and a message', (outcome) => {
    const code = REDEEM_FAILURE_ERRORS[outcome];
    expect(code).toMatch(/^PC_(VOUCHER|VALIDATOR)_/);
    expect(REDEEM_FAILURE_MESSAGES[outcome].length).toBeGreaterThan(0);
  });

  it('maps the lapsed window to PC_VOUCHER_NOT_ACTIVE so the cashier asks for a new code', () => {
    expect(REDEEM_FAILURE_ERRORS.activation_expired).toBe('PC_VOUCHER_NOT_ACTIVE');
    expect(REDEEM_FAILURE_ERRORS.device_inactive).toBe('PC_VALIDATOR_INACTIVE');
  });
});
