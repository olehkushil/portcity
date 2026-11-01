import type { IncomingHttpHeaders } from 'node:http';
import { uuidv7 } from 'uuidv7';
import { FAKE_TX, RewardsWorld, tenantSummary } from '../../../../test/rewards/support/fakes';
import { sha256Hex, verifyPassword } from '../../../common/auth/crypto';
import type { AdminContext } from './validator-devices.service';

const ADMIN: AdminContext = { actor: { type: 'admin', id: 'admin-1' }, ip: '10.0.0.1' };

function keyHeaders(key: string, extra: Record<string, string> = {}): IncomingHttpHeaders {
  return { 'x-validator-key': key, ...extra };
}

describe('ValidatorDevicesService', () => {
  let world: RewardsWorld;
  let tenantId: string;

  beforeEach(() => {
    world = new RewardsWorld();
    tenantId = world.content.add(tenantSummary()).id;
  });

  it('creates a device, returns the raw key once and stores only hashes', async () => {
    const { device, deviceKey } = await world.devices.create(
      { name: '  Aroma Kava, каса 1  ', tenantId, pin: '1234' },
      ADMIN,
    );
    expect(deviceKey.length).toBeGreaterThanOrEqual(43);
    expect(device).toMatchObject({
      name: 'Aroma Kava, каса 1',
      tenantId,
      active: true,
      revokedAt: null,
    });
    const stored = world.repo.device(device.id)!;
    expect(stored.deviceKeyHash).toBe(sha256Hex(deviceKey));
    expect(stored.pinHash).toMatch(/^\$scrypt\$/);
    expect(await verifyPassword('1234', stored.pinHash)).toBe(true);

    const audit = world.audit.entries[0]!;
    expect(audit.tx).toBe(FAKE_TX);
    expect(audit.entry).toMatchObject({
      action: 'validator_device.create',
      entityId: device.id,
      ip: '10.0.0.1',
    });
    expect(JSON.stringify(audit.entry)).not.toContain(stored.pinHash);
    expect(JSON.stringify(audit.entry)).not.toContain(stored.deviceKeyHash);

    // The new device authenticates with the returned key and opens a shift with the PIN.
    await expect(
      world.validator.authenticate(keyHeaders(deviceKey), { requireShift: false }),
    ).resolves.toMatchObject({ deviceId: device.id, authMethod: 'key' });
    await expect(world.validator.openShift(device.id, '1234')).resolves.toMatchObject({
      device: { deviceId: device.id, authMethod: 'shift' },
    });
  });

  it('setPin clears a PIN lock and the failure counter', async () => {
    const { device } = await world.devices.create({ name: 'Каса', tenantId, pin: '123456' }, ADMIN);
    world.repo.putDevice({
      ...world.repo.device(device.id)!,
      failedPinAttempts: 0,
      pinLockedUntil: new Date('2026-11-01T10:15:00.000Z'),
    });
    await world.devices.setPin(device.id, '654321', ADMIN);
    expect(world.repo.device(device.id)).toMatchObject({
      failedPinAttempts: 0,
      pinLockedUntil: null,
    });
    await expect(world.validator.openShift(device.id, '654321')).resolves.toBeDefined();
  });

  it('creates a mall device without tenant', async () => {
    const { device } = await world.devices.create({ name: 'Інфостійка', pin: '123456' }, ADMIN);
    expect(device.tenantId).toBeNull();
  });

  it('rejects an unknown tenant and skips the check when content is unavailable', async () => {
    await expect(
      world.devices.create({ name: 'X', tenantId: uuidv7(), pin: '1234' }, ADMIN),
    ).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
    });
    world.content.fail = true;
    await expect(
      world.devices.create({ name: 'X', tenantId: uuidv7(), pin: '1234' }, ADMIN),
    ).resolves.toBeDefined();
  });

  it('updates name and tenant, re-activation clears revokedAt', async () => {
    const { device } = await world.seedDevice({
      tenantId,
      overrides: { active: false, revokedAt: world.now() },
    });
    const other = world.content.add(tenantSummary({ slug: 'intertop', name: 'INTERTOP' }));
    const updated = await world.devices.update(
      device.id,
      { name: 'Каса 2', tenantId: other.id, active: true },
      ADMIN,
    );
    expect(updated).toMatchObject({
      name: 'Каса 2',
      tenantId: other.id,
      active: true,
      revokedAt: null,
    });
    expect(world.audit.entries[0]?.entry).toMatchObject({
      action: 'validator_device.update',
      before: { active: false },
      after: { active: true, tenantId: other.id },
    });
  });

  it('revokes a device remotely and keeps the first revocation time', async () => {
    const { device, key } = await world.seedDevice({ tenantId });
    const revoked = await world.devices.revoke(device.id, { ...ADMIN, reason: 'tablet stolen' });
    expect(revoked).toMatchObject({ active: false, revokedAt: world.now() });
    await expect(
      world.validator.authenticate(keyHeaders(key), { requireShift: false }),
    ).rejects.toMatchObject({ code: 'PC_VALIDATOR_INACTIVE' });

    world.clock.advanceMinutes(5);
    const again = await world.devices.revoke(device.id, ADMIN);
    expect(again.revokedAt).toEqual(revoked.revokedAt);
    expect(world.audit.actions()).toEqual(['validator_device.revoke', 'validator_device.revoke']);
    expect(world.audit.entries[0]?.entry.reason).toBe('tablet stolen');
  });

  it('rotates the key: the old key stops working, the new one works', async () => {
    const { device, key } = await world.seedDevice({ tenantId });
    const { deviceKey } = await world.devices.rotateKey(device.id, ADMIN);
    expect(deviceKey).not.toBe(key);
    await expect(
      world.validator.authenticate(keyHeaders(key), { requireShift: false }),
    ).rejects.toMatchObject({
      code: 'PC_VALIDATOR_UNAUTHORIZED',
    });
    await expect(
      world.validator.authenticate(keyHeaders(deviceKey), { requireShift: false }),
    ).resolves.toMatchObject({
      deviceId: device.id,
    });
    expect(world.audit.actions()).toEqual(['validator_device.rotate_key']);
  });

  it('sets a new PIN and closes open shifts', async () => {
    const { device, key } = await world.seedDevice({ tenantId, pin: '1234' });
    const shift = await world.validator.openShift(device.id, '1234');
    await world.devices.setPin(device.id, '987654', ADMIN);
    expect(await verifyPassword('987654', world.repo.device(device.id)!.pinHash)).toBe(true);
    await expect(
      world.validator.authenticate(keyHeaders(key, { 'x-validator-shift': shift.shiftToken }), {
        requireShift: true,
      }),
    ).rejects.toMatchObject({ code: 'PC_VALIDATOR_PIN_REQUIRED' });
    expect(JSON.stringify(world.audit.entries[0]?.entry)).not.toContain('987654');
  });

  it('lists devices with filters and pages', async () => {
    await world.seedDevice({ tenantId });
    world.clock.advanceSeconds(1);
    await world.seedDevice({ tenantId: null });
    world.clock.advanceSeconds(1);
    await world.seedDevice({ tenantId, overrides: { active: false } });
    expect((await world.devices.list({ limit: 10 })).items).toHaveLength(3);
    expect((await world.devices.list({ limit: 10, tenantId })).items).toHaveLength(2);
    expect((await world.devices.list({ limit: 10, active: false })).items).toHaveLength(1);
    const first = await world.devices.list({ limit: 2 });
    const second = await world.devices.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('reads the redemption log of a device', async () => {
    const { device } = await world.seedDevice({ tenantId });
    await world.validator
      .redeem(
        {
          deviceId: device.id,
          name: device.name,
          tenantId,
          authMethod: 'shift',
          shiftExpiresAt: null,
        },
        { code: 'ZZZZZZ' },
        null,
      )
      .catch(() => undefined);
    const page = await world.devices.listLog(device.id, undefined, 10);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ outcome: 'not_found', voucher: null });
  });

  it.each(['get', 'revoke', 'rotateKey', 'listLog'] as const)(
    '%s throws PC_VALIDATOR_NOT_FOUND for unknown devices',
    async (method) => {
      const id = uuidv7();
      const call =
        method === 'get'
          ? world.devices.get(id)
          : method === 'listLog'
            ? world.devices.listLog(id, undefined, 10)
            : world.devices[method](id, ADMIN);
      await expect(call).rejects.toMatchObject({ code: 'PC_VALIDATOR_NOT_FOUND', status: 404 });
    },
  );
});
