import { Logger } from '@nestjs/common';
import { TEST_PHONE, createIdentityHarness, loginMember } from '../testing/fixtures';

describe('DevicesService', () => {
  it('registers a push token on the current device and takes it away from other rows', async () => {
    const h = createIdentityHarness();
    const other = h.store.seedUser({
      id: 'u-other',
      phone: '+380671112233',
      memberCode: '100000009',
    });
    h.store.seedDevice({
      id: 'd-other',
      userId: other.id,
      pushToken: 'shared-fcm-token',
      pushEnabled: true,
    });
    const login = await loginMember(h);
    const eventsBefore = h.store.events.length;

    const device = await h.devices.updateCurrentDevice(login.user.id, login.deviceId, {
      pushToken: 'shared-fcm-token',
      appVersion: '1.1.0',
    });

    expect(device).toMatchObject({
      id: login.deviceId,
      pushEnabled: true,
      hasPushToken: true,
      appVersion: '1.1.0',
      current: true,
    });
    expect(h.store.state.devices.get('d-other')).toMatchObject({
      pushToken: null,
      pushEnabled: false,
    });
    expect(h.store.events.slice(eventsBefore).map((event) => event.type)).toEqual([
      'user.device_registered',
    ]);
    expect(h.store.events.at(-1)?.payload).toMatchObject({
      deviceId: login.deviceId,
      pushEnabled: true,
    });
  });

  it('audits and logs a moved push token without exposing the other member', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const h = createIdentityHarness();
    h.store.seedUser({ id: 'u-other', phone: '+380671112233', memberCode: '100000009' });
    h.store.seedDevice({
      id: 'd-other',
      userId: 'u-other',
      pushToken: 'shared-fcm-token',
      pushEnabled: true,
    });
    const login = await loginMember(h);
    const auditsBefore = h.store.audits.length;

    await h.devices.updateCurrentDevice(login.user.id, login.deviceId, {
      pushToken: 'shared-fcm-token',
    });

    const audits = h.store.audits.slice(auditsBefore);
    expect(audits).toEqual([
      {
        actor: { type: 'user', id: login.user.id },
        action: 'device.push_token_moved',
        entityType: 'device',
        entityId: login.deviceId,
        after: { detachedFromOtherDevices: 1 },
      },
    ]);
    const lines = log.mock.calls.map(([message]) => String(message));
    expect(lines).toContainEqual(
      `Push token registered on device ${login.deviceId} was detached from 1 other device(s)`,
    );
    const written = JSON.stringify({ audits, lines });
    expect(written).not.toContain('u-other');
    expect(written).not.toContain('d-other');
    expect(written).not.toContain('shared-fcm-token');

    // The same token again moves nothing and writes nothing.
    await h.devices.updateCurrentDevice(login.user.id, login.deviceId, {
      pushToken: 'shared-fcm-token',
    });
    expect(h.store.audits.length).toBe(auditsBefore + 1);
  });

  it('audits a token taken over at login (device info carries the push token)', async () => {
    const h = createIdentityHarness();
    h.store.seedUser({ id: 'u-other', phone: '+380671112233', memberCode: '100000009' });
    h.store.seedDevice({
      id: 'd-other',
      userId: 'u-other',
      pushToken: 'login-fcm-token',
      pushEnabled: true,
    });
    const login = await loginMember(h, TEST_PHONE, {
      platform: 'android',
      fingerprint: 'install-fingerprint-0002',
      pushToken: 'login-fcm-token',
    });
    expect(h.store.state.devices.get('d-other')?.pushToken).toBeNull();
    expect(h.store.audits.at(-1)).toMatchObject({
      action: 'device.push_token_moved',
      entityId: login.deviceId,
      after: { detachedFromOtherDevices: 1 },
    });
  });

  it('removes the token and disables push with null', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await h.devices.updateCurrentDevice(login.user.id, login.deviceId, { pushToken: 'token-1' });
    const device = await h.devices.updateCurrentDevice(login.user.id, login.deviceId, {
      pushToken: null,
    });
    expect(device).toMatchObject({ pushEnabled: false, hasPushToken: false });
    await expect(h.port.listPushDevices(login.user.id)).resolves.toEqual([]);
  });

  it('can pause push without dropping the token and does not enable push without a token', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await expect(
      h.devices.updateCurrentDevice(login.user.id, login.deviceId, { pushEnabled: true }),
    ).resolves.toMatchObject({ pushEnabled: false });
    await h.devices.updateCurrentDevice(login.user.id, login.deviceId, { pushToken: 'token-1' });
    await expect(
      h.devices.updateCurrentDevice(login.user.id, login.deviceId, { pushEnabled: false }),
    ).resolves.toMatchObject({ pushEnabled: false, hasPushToken: true });
  });

  it('requires a device bound to the token and owned by the member', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await expect(
      h.devices.updateCurrentDevice(login.user.id, undefined, { pushToken: 't' }),
    ).rejects.toMatchObject({ code: 'PC_DEVICE_NOT_FOUND', status: 404 });
    await expect(
      h.devices.updateCurrentDevice('another-user', login.deviceId, { pushToken: 't' }),
    ).rejects.toMatchObject({ code: 'PC_DEVICE_NOT_FOUND' });
  });

  it('lists devices and marks the current one', async () => {
    const h = createIdentityHarness();
    const first = await loginMember(h, TEST_PHONE, {
      platform: 'android',
      fingerprint: 'fp-android-1',
    });
    const second = await loginMember(h, TEST_PHONE, {
      platform: 'ios',
      fingerprint: 'fp-ios-0001',
    });
    const { devices } = await h.devices.listDevices(first.user.id, second.deviceId);
    expect(devices.map((device) => [device.id, device.current])).toEqual([
      [first.deviceId, false],
      [second.deviceId, true],
    ]);
  });

  it('signs a device out: sessions revoked, push cleared, row kept', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await h.devices.updateCurrentDevice(login.user.id, login.deviceId, { pushToken: 'token-1' });
    await expect(h.devices.removeDevice(login.user.id, login.deviceId)).resolves.toEqual({
      deviceId: login.deviceId,
      revokedSessions: 1,
    });
    expect(h.store.state.devices.get(login.deviceId)?.pushToken).toBeNull();
    await expect(h.sessions.refresh(login.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
  });

  it('reuses the device row on re-login and refreshes its details', async () => {
    const h = createIdentityHarness();
    const first = await loginMember(h);
    const again = await loginMember(h, TEST_PHONE, {
      platform: 'android',
      fingerprint: 'install-fingerprint-0001',
      model: 'Pixel 9',
      appVersion: '1.2.0',
      pushToken: 'fresh-token',
    });
    expect(again.deviceId).toBe(first.deviceId);
    expect(h.store.state.devices.get(first.deviceId)).toMatchObject({
      model: 'Pixel 9',
      appVersion: '1.2.0',
      pushToken: 'fresh-token',
      pushEnabled: true,
    });
    expect(h.store.state.devices.size).toBe(1);
  });
});
