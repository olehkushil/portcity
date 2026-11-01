import { REFRESH_REUSE_GRACE_SECONDS } from '../domain/refresh-rotation';
import { TEST_PHONE, createIdentityHarness, loginMember } from '../testing/fixtures';

describe('SessionService.refresh', () => {
  it('rotates the refresh token inside the same family', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    h.clock.advanceMinutes(20);

    const { session, user } = await h.sessions.refresh(login.refreshToken);

    expect(user.id).toBe(login.user.id);
    expect(session.refreshToken).not.toBe(login.refreshToken);
    expect(session.deviceId).toBe(login.deviceId);
    expect(h.tokens.verifyAccessToken(session.accessToken)).toMatchObject({
      sub: login.user.id,
      did: login.deviceId,
    });
    const old = await h.store.findRefreshTokenByHash(h.tokens.hashRefreshToken(login.refreshToken));
    const next = await h.store.findRefreshTokenByHash(
      h.tokens.hashRefreshToken(session.refreshToken),
    );
    expect(old?.replacedById).toBe(next?.id);
    expect(old?.revokedAt).toEqual(h.clock.now());
    expect(next?.family).toBe(old?.family);
    expect(h.store.state.devices.get(login.deviceId)?.lastSeenAt).toEqual(h.clock.now());
  });

  it('revokes the whole family when a rotated token is reused after the grace window', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const { session } = await h.sessions.refresh(login.refreshToken);
    h.clock.advanceSeconds(REFRESH_REUSE_GRACE_SECONDS + 1);

    await expect(h.sessions.refresh(login.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_REUSED',
      status: 401,
    });
    await expect(h.sessions.refresh(session.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
    await expect(h.store.listActiveSessions(login.user.id, h.clock.now())).resolves.toEqual([]);
  });

  it('treats a double refresh inside the grace window as a plain invalid token', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const { session } = await h.sessions.refresh(login.refreshToken);
    h.clock.advanceSeconds(2);

    await expect(h.sessions.refresh(login.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
    await expect(h.sessions.refresh(session.refreshToken)).resolves.toBeDefined();
  });

  it('rejects unknown and expired tokens', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await expect(h.sessions.refresh('x'.repeat(43))).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
    h.clock.advanceDays(61);
    await expect(h.sessions.refresh(login.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
  });

  it('refuses blocked members and revokes their family', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const user = h.store.state.users.get(login.user.id);
    if (user) {
      user.status = 'blocked';
    }
    await expect(h.sessions.refresh(login.refreshToken)).rejects.toMatchObject({
      code: 'PC_USER_BLOCKED',
    });
    await expect(h.store.listActiveSessions(login.user.id, h.clock.now())).resolves.toEqual([]);
  });
});

describe('SessionService.logout', () => {
  async function loginOnTwoDevices() {
    const h = createIdentityHarness();
    const phone = await loginMember(h, TEST_PHONE, {
      platform: 'android',
      fingerprint: 'fingerprint-phone-1',
    });
    const tablet = await loginMember(h, TEST_PHONE, {
      platform: 'ios',
      fingerprint: 'fingerprint-tablet-1',
    });
    for (const deviceId of [phone.deviceId, tablet.deviceId]) {
      await h.devices.updateCurrentDevice(phone.user.id, deviceId, {
        pushToken: `push-${deviceId}`,
      });
    }
    return { h, phone, tablet, userId: phone.user.id };
  }

  it('ends the sessions of the current device and stops its push', async () => {
    const { h, phone, tablet, userId } = await loginOnTwoDevices();
    await expect(h.sessions.logout(userId, phone.deviceId, {})).resolves.toBe(1);

    await expect(h.sessions.refresh(phone.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
    await expect(h.sessions.refresh(tablet.refreshToken)).resolves.toBeDefined();
    expect(h.store.state.devices.get(phone.deviceId)).toMatchObject({
      pushToken: null,
      pushEnabled: false,
    });
    expect(h.store.state.devices.get(tablet.deviceId)?.pushToken).toBe(`push-${tablet.deviceId}`);
  });

  it('ends one login by refresh token, ignoring tokens of other members', async () => {
    const { h, phone, tablet, userId } = await loginOnTwoDevices();
    await expect(
      h.sessions.logout('someone-else', undefined, { refreshToken: tablet.refreshToken }),
    ).resolves.toBe(0);
    await expect(
      h.sessions.logout(userId, phone.deviceId, { refreshToken: tablet.refreshToken }),
    ).resolves.toBe(1);
    await expect(h.sessions.refresh(tablet.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
    await expect(h.sessions.refresh(phone.refreshToken)).resolves.toBeDefined();
  });

  it('ends every session on every device', async () => {
    const { h, userId } = await loginOnTwoDevices();
    await expect(h.sessions.logout(userId, undefined, { allDevices: true })).resolves.toBe(2);
    await expect(h.store.listActiveSessions(userId, h.clock.now())).resolves.toEqual([]);
    await expect(h.store.listPushDevices(userId)).resolves.toEqual([]);
  });

  it('does nothing without a device and without a token', async () => {
    const { h, userId } = await loginOnTwoDevices();
    await expect(h.sessions.logout(userId, undefined, {})).resolves.toBe(0);
  });
});
