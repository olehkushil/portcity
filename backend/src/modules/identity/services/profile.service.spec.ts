import type { TypedOutboxEventInput } from '../../../common/contracts/events';
import { TEST_PHONE, createIdentityHarness, loginMember } from '../testing/fixtures';
import { EXPORT_NOTE } from './profile.service';

const isFieldEvent = (
  event: TypedOutboxEventInput,
): event is TypedOutboxEventInput<'user.profile_field_completed'> =>
  event.type === 'user.profile_field_completed';

describe('ProfileService', () => {
  it('returns the profile with consent states, no deletion request and the current device', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const profile = await h.profiles.getProfile(login.user.id, login.deviceId);

    expect(profile.user).toMatchObject({
      id: login.user.id,
      phone: TEST_PHONE,
      profileCompleted: false,
    });
    expect(profile.consents.map((consent) => [consent.purpose, consent.granted])).toEqual([
      ['program', false],
      ['marketing', false],
      ['profiling', false],
    ]);
    expect(profile.deletionRequest).toBeNull();
    expect(profile.currentDevice).toMatchObject({ id: login.deviceId, current: true });
    expect(profile.user).toMatchObject({ gender: null, city: null });
    expect(profile.children).toEqual([]);
    expect(profile.profileCompletion).toEqual({
      percent: 0,
      missing: ['firstName', 'lastName', 'birthDate', 'email', 'gender', 'city', 'children'],
      bonusPerField: 10,
      bonusComplete: 20,
    });
  });

  it('stores gender and city and reports the bonus values from configuration', async () => {
    const h = createIdentityHarness({
      identity: { PROFILE_BONUS_PER_FIELD: '15', PROFILE_BONUS_COMPLETE: '50' },
    });
    const login = await loginMember(h);
    const profile = await h.profiles.updateProfile(login.user.id, login.deviceId, {
      gender: 'unspecified',
      city: '  Луцьк ',
    });
    expect(profile.user).toMatchObject({ gender: 'unspecified', city: 'Луцьк' });
    expect(profile.profileCompletion).toEqual({
      percent: 28,
      missing: ['firstName', 'lastName', 'birthDate', 'email', 'children'],
      bonusPerField: 15,
      bonusComplete: 50,
    });
  });

  it('publishes user.profile_field_completed once per field, the last one flagged complete', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const userId = login.user.id;
    const fieldEvents = () => h.store.events.filter(isFieldEvent);

    await h.profiles.updateProfile(userId, login.deviceId, { firstName: 'Олег', city: 'Луцьк' });
    expect(fieldEvents().map((event) => event.payload)).toEqual([
      {
        userId,
        field: 'firstName',
        completedAt: '2026-03-10T10:00:00.000Z',
        allFieldsCompleted: false,
      },
      { userId, field: 'city', completedAt: '2026-03-10T10:00:00.000Z', allFieldsCompleted: false },
    ]);
    expect(h.store.state.users.get(userId)?.completedProfileFields).toEqual(['firstName', 'city']);

    // Clearing and refilling a field announces nothing (no bonus farming).
    await h.profiles.updateProfile(userId, login.deviceId, { city: null });
    await h.profiles.updateProfile(userId, login.deviceId, { city: 'Київ' });
    expect(fieldEvents()).toHaveLength(2);

    h.clock.advanceMinutes(5);
    await h.profiles.updateProfile(userId, login.deviceId, {
      lastName: 'Демо',
      birthDate: '1990-05-14',
      email: 'oleh@example.com',
      gender: 'male',
    });
    expect(fieldEvents().map((event) => event.payload.field)).toEqual([
      'firstName',
      'city',
      'lastName',
      'birthDate',
      'email',
      'gender',
    ]);
    expect(fieldEvents().every((event) => event.payload.allFieldsCompleted === false)).toBe(true);

    await h.children.create(userId, { birthMonth: 5, birthYear: 2019 });
    expect(fieldEvents().at(-1)?.payload).toEqual({
      userId,
      field: 'children',
      completedAt: '2026-03-10T10:05:00.000Z',
      allFieldsCompleted: true,
    });
    const profile = await h.profiles.getProfile(userId);
    expect(profile.profileCompletion).toMatchObject({ percent: 100, missing: [] });

    await h.children.create(userId, { birthMonth: 1, birthYear: 2021 });
    expect(fieldEvents()).toHaveLength(7);
  });

  it('does not announce a field twice under parallel updates', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await Promise.all([
      h.profiles.updateProfile(login.user.id, login.deviceId, { city: 'Луцьк' }),
      h.profiles.updateProfile(login.user.id, login.deviceId, { city: 'Рівне' }),
    ]);
    expect(
      h.store.events.filter(isFieldEvent).filter((event) => event.payload.field === 'city'),
    ).toHaveLength(1);
  });

  it('refuses missing, blocked and deleted accounts', async () => {
    const h = createIdentityHarness();
    h.store.seedUser({
      id: 'u-blocked',
      phone: '+380671112233',
      memberCode: '100000009',
      status: 'blocked',
    });
    h.store.seedUser({
      id: 'u-deleted',
      phone: 'anon:abc',
      memberCode: '100000017',
      status: 'deleted',
    });
    await expect(h.profiles.getProfile('missing')).rejects.toMatchObject({
      code: 'PC_USER_NOT_FOUND',
    });
    await expect(h.profiles.getProfile('u-blocked')).rejects.toMatchObject({
      code: 'PC_USER_BLOCKED',
    });
    await expect(h.profiles.getProfile('u-deleted')).rejects.toMatchObject({
      code: 'PC_USER_DELETED',
      status: 410,
    });
  });

  it('publishes user.profile_completed once, when the profile becomes complete', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const before = h.store.events.length;

    const partial = await h.profiles.updateProfile(login.user.id, login.deviceId, {
      firstName: '  Олег ',
      lastName: 'Демо',
    });
    expect(partial.user).toMatchObject({
      firstName: 'Олег',
      lastName: 'Демо',
      profileCompleted: false,
    });
    const completedEvents = () =>
      h.store.events.slice(before).filter((event) => event.type === 'user.profile_completed');
    expect(completedEvents()).toHaveLength(0);

    h.clock.advanceMinutes(1);
    const complete = await h.profiles.updateProfile(login.user.id, login.deviceId, {
      birthDate: '1990-05-14',
      email: ' Oleh@Example.COM ',
    });
    expect(complete.user).toMatchObject({
      birthDate: '1990-05-14',
      email: 'oleh@example.com',
      profileCompleted: true,
      profileCompletedAt: '2026-03-10T10:01:00.000Z',
    });
    expect(completedEvents()).toEqual([
      expect.objectContaining({
        type: 'user.profile_completed',
        payload: { userId: login.user.id, completedAt: '2026-03-10T10:01:00.000Z' },
      }),
    ]);

    await h.profiles.updateProfile(login.user.id, login.deviceId, { firstName: 'Олександр' });
    expect(h.store.eventTypes().filter((type) => type === 'user.profile_completed')).toHaveLength(
      1,
    );
  });

  it('rejects an e-mail of another member and an unacceptable birth date', async () => {
    const h = createIdentityHarness();
    h.store.seedUser({
      id: 'u-other',
      phone: '+380671112233',
      memberCode: '100000009',
      email: 'taken@example.com',
    });
    const login = await loginMember(h);
    await expect(
      h.profiles.updateProfile(login.user.id, undefined, { email: 'TAKEN@example.com' }),
    ).rejects.toMatchObject({ code: 'PC_USER_EMAIL_TAKEN', status: 409 });
    await expect(
      h.profiles.updateProfile(login.user.id, undefined, { birthDate: '2020-01-01' }),
    ).rejects.toMatchObject({ code: 'PC_USER_BIRTHDATE_INVALID', status: 422 });
  });

  it('returns the unchanged profile for an empty patch', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const profile = await h.profiles.updateProfile(login.user.id, undefined, {});
    expect(profile.user.id).toBe(login.user.id);
    expect(profile.currentDevice).toBeNull();
  });

  it('grants and revokes consents, keeping the program consent', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    const granted = await h.profiles.updateConsents(login.user.id, [
      { purpose: 'program', granted: true, version: '2026-10' },
      { purpose: 'marketing', granted: true, version: '2026-10' },
    ]);
    expect(granted.consents.filter((consent) => consent.granted).map((c) => c.purpose)).toEqual([
      'program',
      'marketing',
    ]);

    h.clock.advanceMinutes(5);
    const revoked = await h.profiles.updateConsents(login.user.id, [
      { purpose: 'marketing', granted: false },
    ]);
    expect(revoked.consents.find((consent) => consent.purpose === 'marketing')).toMatchObject({
      granted: false,
      revokedAt: '2026-03-10T10:05:00.000Z',
    });
    await expect(
      h.profiles.updateConsents(login.user.id, [{ purpose: 'program', granted: false }]),
    ).rejects.toMatchObject({ code: 'PC_CONSENT_PROGRAM_REQUIRED', status: 422 });
  });

  it('exports identity data without secrets, also for blocked members', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await h.profiles.updateConsents(login.user.id, [
      { purpose: 'marketing', granted: true, version: 'v1' },
    ]);
    await h.profiles.updateConsents(login.user.id, [{ purpose: 'marketing', granted: false }]);
    await h.devices.updateCurrentDevice(login.user.id, login.deviceId, {
      pushToken: 'secret-push',
    });
    const user = h.store.state.users.get(login.user.id);
    if (user) {
      user.status = 'blocked';
    }

    const data = await h.profiles.exportPersonalData(login.user.id, login.deviceId);

    expect(data.exportedAt).toBe('2026-03-10T10:00:00.000Z');
    expect(data.user.id).toBe(login.user.id);
    expect(data.devices).toHaveLength(1);
    expect(data.consentHistory).toEqual([
      expect.objectContaining({ purpose: 'marketing', version: 'v1', granted: false }),
    ]);
    expect(data.sessions).toEqual([
      expect.objectContaining({ active: true, deviceId: login.deviceId }),
    ]);
    expect(data.note).toBe(EXPORT_NOTE);
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('secret-push');
    expect(serialised).not.toContain(login.refreshToken);
    expect(serialised).not.toContain(h.tokens.hashRefreshToken(login.refreshToken));
  });

  it('refuses the export for anonymised accounts', async () => {
    const h = createIdentityHarness();
    h.store.seedUser({
      id: 'u-deleted',
      phone: 'anon:abc',
      memberCode: '100000017',
      status: 'deleted',
    });
    await expect(h.profiles.exportPersonalData('u-deleted')).rejects.toMatchObject({
      code: 'PC_USER_DELETED',
    });
    await expect(h.profiles.exportPersonalData('missing')).rejects.toMatchObject({
      code: 'PC_USER_NOT_FOUND',
    });
  });
});
