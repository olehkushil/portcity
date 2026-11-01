import { createIdentityHarness, loginMember } from '../testing/fixtures';

describe('IdentityPortService', () => {
  function seeded() {
    const h = createIdentityHarness();
    h.store.seedUser({
      id: 'u-1',
      phone: '+380501234567',
      memberCode: '734211800',
      firstName: 'Олег',
      birthDate: new Date('1990-05-14T00:00:00Z'),
    });
    h.store.seedUser({
      id: 'u-2',
      phone: '+380671112233',
      memberCode: '100000009',
      status: 'blocked',
    });
    return h;
  }

  it('returns user summaries with yyyy-MM-dd birth dates and null for unknown ids', async () => {
    const h = seeded();
    await expect(h.port.getUser('u-1')).resolves.toMatchObject({
      id: 'u-1',
      phone: '+380501234567',
      firstName: 'Олег',
      birthDate: '1990-05-14',
      status: 'active',
      memberCode: '734211800',
    });
    await expect(h.port.getUser('missing')).resolves.toBeNull();
  });

  it('batch-loads users, ignoring duplicates and missing ids', async () => {
    const h = seeded();
    const users = await h.port.getUsers(['u-2', 'u-1', 'u-2', 'missing']);
    expect(users.map((user) => user.id).sort()).toEqual(['u-1', 'u-2']);
    await expect(h.port.getUsers([])).resolves.toEqual([]);
  });

  it('resolves member codes typed with spaces and ignores malformed input', async () => {
    const h = seeded();
    await expect(h.port.resolveMemberCode('734 211 800')).resolves.toMatchObject({ id: 'u-1' });
    await expect(h.port.resolveMemberCode('100000009')).resolves.toMatchObject({
      status: 'blocked',
    });
    await expect(h.port.resolveMemberCode('12345')).resolves.toBeNull();
    await expect(h.port.resolveMemberCode('999999999')).resolves.toBeNull();
  });

  it('exposes devices and push-capable devices only', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await expect(h.port.getDevice(login.deviceId)).resolves.toMatchObject({
      userId: login.user.id,
      platform: 'android',
      pushEnabled: false,
    });
    await expect(h.port.listPushDevices(login.user.id)).resolves.toEqual([]);
    await h.devices.updateCurrentDevice(login.user.id, login.deviceId, { pushToken: 'fcm-1' });
    await expect(h.port.listPushDevices(login.user.id)).resolves.toEqual([
      expect.objectContaining({ id: login.deviceId, pushToken: 'fcm-1' }),
    ]);
    await expect(h.port.getDevice('missing')).resolves.toBeNull();
  });

  it('answers consent questions by the latest record', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await expect(h.port.hasConsent(login.user.id, 'marketing')).resolves.toBe(false);
    await h.profiles.updateConsents(login.user.id, [
      { purpose: 'marketing', granted: true, version: '2026-10' },
    ]);
    await expect(h.port.hasConsent(login.user.id, 'marketing')).resolves.toBe(true);
    h.clock.advanceMinutes(1);
    await h.profiles.updateConsents(login.user.id, [{ purpose: 'marketing', granted: false }]);
    await expect(h.port.hasConsent(login.user.id, 'marketing')).resolves.toBe(false);
  });

  describe('listMarketingAudience', () => {
    function audienceHarness() {
      const h = createIdentityHarness();
      const at = (minute: number): Date => new Date(Date.UTC(2026, 0, 15, 9, minute));
      const ids = ['u-a', 'u-b', 'u-c', 'u-d', 'u-e', 'u-f'];
      ids.forEach((id, index) =>
        h.store.seedUser({
          id,
          phone: `+38050000000${index}`,
          memberCode: `10000000${index}`,
          status: id === 'u-e' ? 'blocked' : 'active',
        }),
      );
      const consent = (
        id: string,
        userId: string,
        minute: number,
        revoked: boolean,
        purpose: 'marketing' | 'program' = 'marketing',
      ): void => {
        h.store.state.consents.set(id, {
          id,
          userId,
          purpose,
          version: '2026-10',
          grantedAt: at(minute),
          revokedAt: revoked ? at(minute + 1) : null,
        });
      };
      consent('c-1', 'u-a', 1, false); // granted
      consent('c-2', 'u-b', 1, false); // granted, later revoked by a newer row
      consent('c-3', 'u-b', 5, true);
      consent('c-4', 'u-c', 1, true); // revoked, then granted again
      consent('c-5', 'u-c', 5, false);
      consent('c-6', 'u-d', 1, false, 'program'); // no marketing consent
      consent('c-7', 'u-e', 1, false); // granted but blocked
      consent('c-8', 'u-f', 1, false); // granted
      return h;
    }

    it('lists active members whose latest marketing consent is granted, by id', async () => {
      const h = audienceHarness();
      await expect(h.port.listMarketingAudience(null, 100)).resolves.toEqual({
        userIds: ['u-a', 'u-c', 'u-f'],
        nextCursor: null,
      });
    });

    it('pages with a cursor (the last id of the previous page)', async () => {
      const h = audienceHarness();
      const first = await h.port.listMarketingAudience(null, 2);
      expect(first).toEqual({ userIds: ['u-a', 'u-c'], nextCursor: 'u-c' });
      await expect(h.port.listMarketingAudience(first.nextCursor, 2)).resolves.toEqual({
        userIds: ['u-f'],
        nextCursor: null,
      });
    });

    it('clamps the page size to 1..1000', async () => {
      const h = audienceHarness();
      const spy = jest.spyOn(h.store, 'listMarketingAudience');
      await expect(h.port.listMarketingAudience(null, 0)).resolves.toEqual({
        userIds: ['u-a'],
        nextCursor: 'u-a',
      });
      await h.port.listMarketingAudience(null, 50_000);
      expect(spy.mock.calls.map((call) => call[1])).toEqual([2, 1001]);
    });
  });

  it('reports the state of a back-office account for the shared AdminGuard', async () => {
    const h = createIdentityHarness();
    h.store.seedAdmin({
      id: 'a-1',
      email: 'mod@portcity.local',
      passwordHash: 'x',
      role: 'moderator',
    });
    h.store.seedAdmin({
      id: 'a-2',
      email: 'gone@portcity.local',
      passwordHash: 'x',
      role: 'manager',
      active: false,
    });
    await expect(h.port.getAdminAccess('a-1')).resolves.toEqual({
      active: true,
      role: 'moderator',
    });
    await expect(h.port.getAdminAccess('a-2')).resolves.toEqual({
      active: false,
      role: 'manager',
    });
    await expect(h.port.getAdminAccess('missing')).resolves.toBeNull();
  });
});
