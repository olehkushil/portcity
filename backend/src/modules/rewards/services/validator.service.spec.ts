import type { IncomingHttpHeaders } from 'node:http';
import type { ValidatorDevice } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { FAST_SCRYPT, RewardsWorld } from '../../../../test/rewards/support/fakes';
import { hashPassword } from '../../../common/auth/crypto';
import { signActivationToken } from '../domain/activation';
import { toUnixSeconds } from '../domain/signed-token';
import { signStaticVoucherQr } from '../domain/static-qr';
import { toValidatorLogPageDto } from './validator.mapper';
import type { ValidatorPrincipal } from './validator.service';

const USER = 'user-1';
const TENANT = 'tenant-aroma';

function headers(values: Record<string, string>): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

describe('ValidatorService', () => {
  let world: RewardsWorld;
  let device: ValidatorDevice;
  let key: string;
  let principal: ValidatorPrincipal;

  beforeEach(async () => {
    world = new RewardsWorld();
    const seeded = await world.seedDevice({ tenantId: TENANT, pin: '1234' });
    device = seeded.device;
    key = seeded.key;
    principal = {
      deviceId: device.id,
      name: device.name,
      tenantId: TENANT,
      authMethod: 'shift',
      shiftExpiresAt: null,
    };
  });

  /** Issues a voucher for the tenant and activates it like the app does. */
  async function activatedVoucher(tenantId: string | null = TENANT) {
    const voucher = await world.vouchers.issue({
      userId: USER,
      kind: 'reward',
      title: 'Кава з собою',
      ...(tenantId ? { tenantId } : {}),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      sourceType: 'admin',
      sourceId: uuidv7(),
    });
    const activation = await world.vouchers.activate(USER, voucher.id);
    world.outbox.events = [];
    return { voucher, activation };
  }

  describe('authenticate', () => {
    it.each([
      ['no key', {}, 'PC_VALIDATOR_UNAUTHORIZED'],
      ['blank key', { 'X-Validator-Key': '   ' }, 'PC_VALIDATOR_UNAUTHORIZED'],
      ['unknown key', { 'X-Validator-Key': 'nope' }, 'PC_VALIDATOR_UNAUTHORIZED'],
    ])('rejects %s', async (_name, values, code) => {
      await expect(
        world.validator.authenticate(headers(values), { requireShift: true }),
      ).rejects.toMatchObject({
        code,
        status: 401,
      });
    });

    it('accepts the key alone when no shift is required', async () => {
      const result = await world.validator.authenticate(headers({ 'X-Validator-Key': key }), {
        requireShift: false,
      });
      expect(result).toEqual({
        deviceId: device.id,
        name: device.name,
        tenantId: TENANT,
        authMethod: 'key',
        shiftExpiresAt: null,
      });
    });

    it('requires a shift proof besides the key', async () => {
      await expect(
        world.validator.authenticate(headers({ 'X-Validator-Key': key }), { requireShift: true }),
      ).rejects.toMatchObject({ code: 'PC_VALIDATOR_PIN_REQUIRED' });
    });

    it('never accepts the PIN outside POST /validator/shift (no X-Validator-Pin fallback)', async () => {
      const verify = jest.spyOn(world.repo, 'incrementPinFailures');
      for (const pin of ['1234', '9999']) {
        await expect(
          world.validator.authenticate(
            headers({ 'X-Validator-Key': key, 'X-Validator-Pin': pin }),
            {
              requireShift: true,
            },
          ),
        ).rejects.toMatchObject({
          code: 'PC_VALIDATOR_PIN_REQUIRED',
          status: 401,
          message: expect.stringContaining('only by POST /validator/shift') as unknown,
        });
      }
      // The header is not even checked, so it cannot be used to guess PINs either.
      expect(verify).not.toHaveBeenCalled();
    });

    it.each([
      ['inactive', { active: false }],
      ['revoked', { revokedAt: new Date('2026-10-31T00:00:00.000Z') }],
    ])('rejects an %s device with 403', async (_name, overrides) => {
      world.repo.putDevice({ ...device, ...overrides });
      await expect(
        world.validator.authenticate(headers({ 'X-Validator-Key': key }), { requireShift: false }),
      ).rejects.toMatchObject({ code: 'PC_VALIDATOR_INACTIVE', status: 403 });
    });

    it('accepts a shift token from openShift until the shift ends', async () => {
      const shift = await world.validator.openShift(device.id, '1234');
      expect(shift.expiresAt).toEqual(new Date('2026-11-01T22:00:00.000Z'));
      expect(shift.device.authMethod).toBe('shift');
      const auth = await world.validator.authenticate(
        headers({ 'X-Validator-Key': key, 'X-Validator-Shift': shift.shiftToken }),
        { requireShift: true },
      );
      expect(auth).toMatchObject({ authMethod: 'shift', shiftExpiresAt: shift.expiresAt });

      world.clock.set(shift.expiresAt);
      await expect(
        world.validator.authenticate(
          headers({ 'X-Validator-Key': key, 'X-Validator-Shift': shift.shiftToken }),
          {
            requireShift: true,
          },
        ),
      ).rejects.toMatchObject({
        code: 'PC_VALIDATOR_PIN_REQUIRED',
        details: { reason: 'expired' },
      });
    });

    it('closes open shifts when the PIN changes', async () => {
      const shift = await world.validator.openShift(device.id, '1234');
      world.repo.putDevice({ ...device, pinHash: await hashPassword('4321', FAST_SCRYPT) });
      await expect(
        world.validator.authenticate(
          headers({ 'X-Validator-Key': key, 'X-Validator-Shift': shift.shiftToken }),
          {
            requireShift: true,
          },
        ),
      ).rejects.toMatchObject({
        code: 'PC_VALIDATOR_PIN_REQUIRED',
        details: { reason: 'bad_signature' },
      });
    });

    it('rejects the shift token of another device', async () => {
      const other = await world.seedDevice({ tenantId: TENANT, pin: '1234' });
      const shift = await world.validator.openShift(other.device.id, '1234');
      await expect(
        world.validator.authenticate(
          headers({ 'X-Validator-Key': key, 'X-Validator-Shift': shift.shiftToken }),
          {
            requireShift: true,
          },
        ),
      ).rejects.toMatchObject({ code: 'PC_VALIDATOR_PIN_REQUIRED' });
    });
  });

  describe('openShift / describe', () => {
    it('rejects a wrong PIN and records lastSeenAt on success', async () => {
      await expect(world.validator.openShift(device.id, '0000')).rejects.toMatchObject({
        code: 'PC_VALIDATOR_PIN_INVALID',
      });
      await world.validator.openShift(device.id, '1234');
      expect(world.repo.device(device.id)?.lastSeenAt).toEqual(world.now());
    });

    it('describe re-reads the device and fails once it is revoked', async () => {
      expect(await world.validator.describe(principal)).toMatchObject({
        deviceId: device.id,
        authMethod: 'shift',
      });
      world.repo.putDevice({ ...device, active: false, revokedAt: world.now() });
      await expect(world.validator.describe(principal)).rejects.toMatchObject({
        code: 'PC_VALIDATOR_INACTIVE',
      });
    });

    it('rejects an unknown device id', async () => {
      await expect(world.validator.openShift(uuidv7(), '1234')).rejects.toMatchObject({
        code: 'PC_VALIDATOR_UNAUTHORIZED',
      });
    });

    it('locks shift opening for 15 minutes after 5 wrong PINs and audits it', async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(
          world.validator.openShift(device.id, '0000', '10.0.0.5'),
        ).rejects.toMatchObject({
          code: 'PC_VALIDATOR_PIN_INVALID',
          details: { attemptsLeft: 5 - attempt },
        });
      }
      expect(world.repo.device(device.id)?.failedPinAttempts).toBe(4);
      await expect(world.validator.openShift(device.id, '0000', '10.0.0.5')).rejects.toMatchObject({
        code: 'PC_VALIDATOR_PIN_LOCKED',
        status: 429,
        details: { lockedUntil: '2026-11-01T10:15:00.000Z' },
      });
      expect(world.repo.device(device.id)).toMatchObject({
        failedPinAttempts: 0,
        pinLockedUntil: new Date('2026-11-01T10:15:00.000Z'),
      });
      expect(world.audit.entries).toHaveLength(1);
      expect(world.audit.entries[0]?.entry).toMatchObject({
        actor: { type: 'system', id: 'validator' },
        action: 'validator_device.pin_locked',
        entityType: 'validator_device',
        entityId: device.id,
        ip: '10.0.0.5',
      });

      // Even the right PIN is refused while locked; nothing is counted meanwhile.
      world.clock.advanceMinutes(14);
      await expect(world.validator.openShift(device.id, '1234')).rejects.toMatchObject({
        code: 'PC_VALIDATOR_PIN_LOCKED',
      });
      world.clock.advanceMinutes(1);
      await expect(world.validator.openShift(device.id, '1234')).resolves.toMatchObject({
        device: { deviceId: device.id },
      });
      expect(world.repo.device(device.id)).toMatchObject({
        failedPinAttempts: 0,
        pinLockedUntil: null,
      });
    });

    it('a successful PIN resets the failure counter', async () => {
      await expect(world.validator.openShift(device.id, '0000')).rejects.toBeDefined();
      await expect(world.validator.openShift(device.id, '0000')).rejects.toBeDefined();
      await world.validator.openShift(device.id, '1234');
      expect(world.repo.device(device.id)?.failedPinAttempts).toBe(0);
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(world.validator.openShift(device.id, '0000')).rejects.toMatchObject({
          code: 'PC_VALIDATOR_PIN_INVALID',
        });
      }
      expect(world.audit.entries).toHaveLength(0);
    });

    it('counts failures per device', async () => {
      const other = await world.seedDevice({ tenantId: TENANT, pin: '1234' });
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await world.validator.openShift(device.id, '0000').catch(() => undefined);
      }
      await expect(world.validator.openShift(other.device.id, '0000')).rejects.toMatchObject({
        code: 'PC_VALIDATOR_PIN_INVALID',
        details: { attemptsLeft: 4 },
      });
    });
  });

  describe('redeem', () => {
    it('redeems by code atomically, publishes voucher.redeemed and logs the attempt', async () => {
      const { voucher, activation } = await activatedVoucher();
      world.clock.advanceSeconds(30);
      const result = await world.validator.redeem(principal, { code: activation.code }, '10.1.1.1');

      expect(result.outcome).toBe('redeemed');
      expect(result.redeemedAt).toEqual(world.now());
      expect(result.voucher).toMatchObject({
        id: voucher.id,
        status: 'redeemed',
        redeemedByTenantId: TENANT,
      });
      expect(result.device).toBe(principal);
      expect(world.repo.voucher(voucher.id)).toMatchObject({
        status: 'redeemed',
        redeemedByDeviceId: device.id,
        redeemedByTenantId: TENANT,
      });
      expect(world.outbox.types()).toEqual(['voucher.redeemed']);
      expect(world.outbox.ofType('voucher.redeemed')[0]?.payload).toMatchObject({
        voucherId: voucher.id,
        redeemedByDeviceId: device.id,
        redeemedByTenantId: TENANT,
        redeemedAt: world.now().toISOString(),
      });
      expect(world.repo.logs).toEqual([
        expect.objectContaining({
          voucherId: voucher.id,
          validatorDeviceId: device.id,
          method: 'code',
          codeTried: activation.code,
          outcome: 'redeemed',
          message: null,
          ip: '10.1.1.1',
        }),
      ]);
    });

    it('redeems by the scanned token', async () => {
      const { voucher, activation } = await activatedVoucher();
      const result = await world.validator.redeem(principal, { token: activation.token }, null);
      expect(result.voucher.id).toBe(voucher.id);
      expect(world.repo.logs[0]).toMatchObject({
        method: 'token',
        codeTried: null,
        outcome: 'redeemed',
      });
    });

    it('normalises a typed code (case, spaces, dashes)', async () => {
      const { activation } = await activatedVoucher();
      const typed = `${activation.code.slice(0, 3).toLowerCase()}-${activation.code.slice(3)}`;
      await expect(world.validator.redeem(principal, { code: typed }, null)).resolves.toMatchObject(
        {
          outcome: 'redeemed',
        },
      );
    });

    it('lets a mall device redeem a tenant voucher', async () => {
      const { activation } = await activatedVoucher();
      const mall = await world.seedDevice({ tenantId: null });
      await expect(
        world.validator.redeem(
          { ...principal, deviceId: mall.device.id, tenantId: null },
          { code: activation.code },
          null,
        ),
      ).resolves.toMatchObject({ voucher: { redeemedByTenantId: null } });
    });

    type Failure = [string, () => Promise<{ code?: string; token?: string }>, string, string];
    const failures: Failure[] = [
      ['unknown code', async () => ({ code: 'ZZZZZZ' }), 'not_found', 'PC_VOUCHER_NOT_FOUND'],
      ['malformed code', async () => ({ code: 'O0O0O0' }), 'not_found', 'PC_VOUCHER_NOT_FOUND'],
      [
        'garbage token',
        async () => ({ token: 'x'.repeat(40) }),
        'not_found',
        'PC_VOUCHER_NOT_FOUND',
      ],
    ];

    it.each(failures)('logs and rejects %s', async (_name, input, outcome, code) => {
      await activatedVoucher();
      await expect(
        world.validator.redeem(principal, await input(), '10.0.0.9'),
      ).rejects.toMatchObject({
        code,
        details: { outcome },
      });
      expect(world.repo.logs).toEqual([
        expect.objectContaining({ outcome, voucherId: null, ip: '10.0.0.9' }),
      ]);
      expect(world.outbox.events).toEqual([]);
    });

    it('truncates the stored code attempt to 16 characters', async () => {
      await expect(
        world.validator.redeem(principal, { code: 'A'.repeat(16) + 'TAIL' }, null),
      ).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_FOUND',
      });
      expect(world.repo.logs[0]?.codeTried).toBe('A'.repeat(16));
    });

    it('rejects a lapsed activation by code as not active', async () => {
      const { voucher, activation } = await activatedVoucher();
      world.clock.advanceSeconds(120);
      const failure = world.validator.redeem(principal, { code: activation.code }, null);
      await expect(failure).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_ACTIVE',
        details: { outcome: 'activation_expired' },
      });
      // Problem documents never carry voucher ids.
      await failure.catch((error: { details?: unknown }) =>
        expect(JSON.stringify(error.details)).not.toContain(voucher.id),
      );
      expect(world.repo.voucher(voucher.id)?.status).toBe('active');
      expect(world.repo.logs[0]?.outcome).toBe('activation_expired');
    });

    it('rejects an expired token as a lapsed activation', async () => {
      const { activation } = await activatedVoucher();
      world.clock.advanceSeconds(121);
      await expect(
        world.validator.redeem(principal, { token: activation.token }, null),
      ).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_ACTIVE',
        details: { outcome: 'activation_expired' },
      });
    });

    it('rejects the token of an earlier activation after re-activation', async () => {
      const { voucher, activation } = await activatedVoucher();
      world.clock.advanceSeconds(119);
      const stale = activation.token;
      world.clock.advanceSeconds(2);
      await world.vouchers.activate(USER, voucher.id);
      // The stale token itself expired; forge one with a live exp but the old hash binding.
      const replay = signActivationToken(
        voucher.id,
        toUnixSeconds(world.now()) + 60,
        'test-voucher-pepper-0123456789',
      );
      await expect(
        world.validator.redeem(principal, { token: replay }, null),
      ).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_ACTIVE',
        details: { outcome: 'not_active' },
      });
      await expect(world.validator.redeem(principal, { token: stale }, null)).rejects.toMatchObject(
        {
          code: 'PC_VOUCHER_NOT_ACTIVE',
        },
      );
    });

    it('rejects a voucher of another tenant and leaves it active', async () => {
      const { voucher, activation } = await activatedVoucher('tenant-intertop');
      await expect(
        world.validator.redeem(principal, { code: activation.code }, null),
      ).rejects.toMatchObject({
        code: 'PC_VOUCHER_WRONG_TENANT',
        details: { outcome: 'wrong_tenant' },
      });
      expect(world.repo.voucher(voucher.id)?.status).toBe('active');
    });

    it("reveals nothing about another tenant's voucher: no id, no state", async () => {
      const { voucher, activation } = await activatedVoucher('tenant-intertop');
      // Redeemed elsewhere: a foreign device must not learn that (only wrong_tenant).
      const mall = await world.seedDevice({ tenantId: null });
      const mallPrincipal = { ...principal, deviceId: mall.device.id, tenantId: null };
      await world.validator.redeem(mallPrincipal, { token: activation.token }, null);

      const failure = world.validator.redeem(principal, { token: activation.token }, null);
      await expect(failure).rejects.toMatchObject({
        code: 'PC_VOUCHER_WRONG_TENANT',
        details: { outcome: 'wrong_tenant' },
      });
      await failure.catch((error: { details?: unknown; message: string }) => {
        expect(JSON.stringify(error.details)).not.toContain(voucher.id);
        expect(error.message).not.toContain(voucher.id);
        expect(error.message).not.toContain('Кава');
      });
      // The device's own log hides the foreign voucher; the back office still sees it.
      const deviceLog = await world.validator.listLog(device.id, undefined, 10);
      expect(deviceLog.items[0]).toMatchObject({ outcome: 'wrong_tenant', voucherId: voucher.id });
      expect(toValidatorLogPageDto(deviceLog, { forDevice: true }).items[0]).toMatchObject({
        outcome: 'wrong_tenant',
        voucherId: null,
        voucher: null,
      });
    });

    describe('static QR of tickets and certificates', () => {
      async function ticket(
        overrides: { tenantId?: string | null; kind?: 'ticket' | 'certificate' | 'coupon' } = {},
      ) {
        const voucher = await world.vouchers.issue({
          userId: USER,
          kind: overrides.kind ?? 'ticket',
          title: 'Майстер-клас для дітей',
          ...(overrides.tenantId === null ? {} : { tenantId: overrides.tenantId ?? TENANT }),
          expiresAt: new Date('2026-11-08T18:00:00.000Z'),
          sourceType: 'event',
          sourceId: uuidv7(),
        });
        world.outbox.events = [];
        const view = await world.vouchers.getForUser(USER, voucher.id);
        return { voucher, qr: view.qrPayload ?? '' };
      }

      it('redeems a ticket once without activation', async () => {
        const { voucher, qr } = await ticket();
        expect(qr).toMatch(/^PCV1:/);
        const result = await world.validator.redeem(principal, { token: qr }, '10.0.0.1');
        expect(result.voucher).toMatchObject({
          id: voucher.id,
          status: 'redeemed',
          qrPayload: null,
        });
        expect(world.outbox.types()).toEqual(['voucher.redeemed']);
        expect(world.repo.logs[0]).toMatchObject({ method: 'token', outcome: 'redeemed' });

        await expect(world.validator.redeem(principal, { token: qr }, null)).rejects.toMatchObject({
          code: 'PC_VOUCHER_ALREADY_REDEEMED',
        });
        expect(world.outbox.ofType('voucher.redeemed')).toHaveLength(1);
      });

      it('also redeems an activated ticket and frees its code', async () => {
        const { voucher, qr } = await ticket();
        await world.vouchers.activate(USER, voucher.id);
        await world.validator.redeem(principal, { token: qr }, null);
        expect(world.repo.voucher(voucher.id)).toMatchObject({
          status: 'redeemed',
          code: null,
          tokenHash: null,
        });
      });

      it('is valid until the voucher expires', async () => {
        const { qr } = await ticket();
        world.clock.set('2026-11-08T18:00:00.000Z');
        await expect(world.validator.redeem(principal, { token: qr }, null)).rejects.toMatchObject({
          code: 'PC_VOUCHER_EXPIRED',
          details: { outcome: 'expired' },
        });
      });

      it('is bound to the expiry the QR was issued for', async () => {
        const { voucher, qr } = await ticket();
        world.repo.putVoucher({
          ...world.repo.voucher(voucher.id)!,
          expiresAt: new Date('2026-11-09T18:00:00.000Z'),
        });
        await expect(world.validator.redeem(principal, { token: qr }, null)).rejects.toMatchObject({
          code: 'PC_VOUCHER_NOT_FOUND',
        });
      });

      it('rejects forged, cancelled and foreign-tenant QR codes', async () => {
        const { voucher, qr } = await ticket();
        const forged = `${qr.slice(0, -3)}AAA`;
        await expect(
          world.validator.redeem(principal, { token: forged }, null),
        ).rejects.toMatchObject({ code: 'PC_VOUCHER_NOT_FOUND' });

        const foreign = await ticket({ tenantId: 'tenant-intertop' });
        await expect(
          world.validator.redeem(principal, { token: foreign.qr }, null),
        ).rejects.toMatchObject({ code: 'PC_VOUCHER_WRONG_TENANT' });

        await world.vouchers.cancel({
          voucherId: voucher.id,
          reason: 'x',
          actor: { type: 'system' },
        });
        await expect(world.validator.redeem(principal, { token: qr }, null)).rejects.toMatchObject({
          code: 'PC_VOUCHER_FINAL',
        });
      });

      it('is only accepted for tickets and certificates', async () => {
        const { voucher } = await ticket({ kind: 'coupon' });
        const forgedForCoupon = signStaticVoucherQr(
          voucher.id,
          voucher.expiresAt,
          'test-voucher-pepper-0123456789',
        );
        await expect(
          world.validator.redeem(principal, { token: forgedForCoupon }, null),
        ).rejects.toMatchObject({ code: 'PC_VOUCHER_NOT_FOUND' });
        expect(world.repo.voucher(voucher.id)?.status).toBe('issued');
      });

      it('a certificate without a tenant goes to a mall device', async () => {
        const { qr } = await ticket({ kind: 'certificate', tenantId: null });
        await expect(world.validator.redeem(principal, { token: qr }, null)).rejects.toMatchObject({
          code: 'PC_VOUCHER_WRONG_TENANT',
        });
        const mall = await world.seedDevice({ tenantId: null });
        await expect(
          world.validator.redeem(
            { ...principal, deviceId: mall.device.id, tenantId: null },
            { token: qr },
            null,
          ),
        ).resolves.toMatchObject({ outcome: 'redeemed' });
      });
    });

    it('refuses a second redemption of the same voucher', async () => {
      const { activation } = await activatedVoucher();
      await world.validator.redeem(principal, { token: activation.token }, null);
      await expect(
        world.validator.redeem(principal, { token: activation.token }, null),
      ).rejects.toMatchObject({
        code: 'PC_VOUCHER_ALREADY_REDEEMED',
        status: 409,
      });
      // By code the voucher no longer holds a live code.
      await expect(
        world.validator.redeem(principal, { code: activation.code }, null),
      ).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_FOUND',
      });
      expect(world.outbox.ofType('voucher.redeemed')).toHaveLength(1);
      expect(world.repo.logs.map((row) => row.outcome)).toEqual([
        'redeemed',
        'already_redeemed',
        'not_found',
      ]);
    });

    it('reports already_redeemed when a concurrent redeem wins the conditional update', async () => {
      const { voucher, activation } = await activatedVoucher();
      const original = world.repo.updateVoucherIf.bind(world.repo);
      jest
        .spyOn(world.repo, 'updateVoucherIf')
        .mockImplementationOnce(async (db, condition, patch) => {
          // Another validator redeems first.
          const current = world.repo.voucher(voucher.id)!;
          world.repo.putVoucher({ ...current, status: 'redeemed', redeemedAt: world.now() });
          return original(db, condition, patch);
        });
      await expect(
        world.validator.redeem(principal, { code: activation.code }, null),
      ).rejects.toMatchObject({
        code: 'PC_VOUCHER_ALREADY_REDEEMED',
      });
      expect(world.outbox.events).toEqual([]);
      expect(world.repo.logs[0]?.outcome).toBe('already_redeemed');
    });

    it('rejects redemption from a device revoked after authentication', async () => {
      const { activation } = await activatedVoucher();
      world.repo.putDevice({ ...device, active: false, revokedAt: world.now() });
      await expect(
        world.validator.redeem(principal, { code: activation.code }, null),
      ).rejects.toMatchObject({
        code: 'PC_VALIDATOR_INACTIVE',
      });
      expect(world.repo.logs[0]?.outcome).toBe('device_inactive');
    });
  });

  describe('listLog', () => {
    it('pages the device log newest first', async () => {
      for (let index = 0; index < 3; index += 1) {
        await world.validator
          .redeem(principal, { code: `ZZZZZ${index + 2}` }, null)
          .catch(() => undefined);
        world.clock.advanceSeconds(1);
      }
      const first = await world.validator.listLog(device.id, undefined, 2);
      expect(first.items.map((row) => row.codeTried)).toEqual(['ZZZZZ4', 'ZZZZZ3']);
      const second = await world.validator.listLog(device.id, first.nextCursor ?? undefined, 2);
      expect(second.items.map((row) => row.codeTried)).toEqual(['ZZZZZ2']);
      expect(second.nextCursor).toBeNull();
      expect((await world.validator.listLog(uuidv7(), undefined, 10)).items).toEqual([]);
    });
  });
});
