import { ACCOUNT_DELETION_DELAY_DAYS } from '../../../common/contracts/identity';
import { anonymisedPhone } from '../domain/deletion';
import { TEST_IP, TEST_PHONE, createIdentityHarness, loginMember } from '../testing/fixtures';
import { ACCOUNT_DELETION_ACTOR } from './account-deletion.service';

async function memberWithData() {
  const h = createIdentityHarness();
  const login = await loginMember(h);
  await h.profiles.updateProfile(login.user.id, login.deviceId, {
    firstName: 'Олег',
    lastName: 'Демо',
    birthDate: '1990-05-14',
    email: 'oleh@example.com',
    gender: 'male',
    city: 'Луцьк',
  });
  await h.children.create(login.user.id, { birthMonth: 5, birthYear: 2019, gender: 'female' });
  await h.profiles.updateConsents(login.user.id, [
    { purpose: 'program', granted: true, version: '2026-10' },
    { purpose: 'marketing', granted: true, version: '2026-10' },
  ]);
  await h.devices.updateCurrentDevice(login.user.id, login.deviceId, { pushToken: 'push-1' });
  return { h, login, userId: login.user.id };
}

describe('AccountDeletionService', () => {
  it('files one pending request with a 30-day cooling-off period', async () => {
    const { h, userId } = await memberWithData();
    const first = await h.deletions.requestDeletion(userId, '  Переїжджаю  ');

    expect(first.created).toBe(true);
    expect(first).toMatchObject({ executeAfter: '2026-04-09T10:00:00.000Z', graceDays: 30 });
    expect(first.request).toMatchObject({
      status: 'pending',
      requestedAt: '2026-03-10T10:00:00.000Z',
      executeAfter: '2026-04-09T10:00:00.000Z',
      reason: 'Переїжджаю',
    });
    expect(h.store.events.at(-1)).toMatchObject({
      type: 'user.deletion_requested',
      payload: { userId, requestId: first.request.id, executeAfter: '2026-04-09T10:00:00.000Z' },
    });

    const second = await h.deletions.requestDeletion(userId);
    expect(second).toEqual({
      request: first.request,
      created: false,
      executeAfter: '2026-04-09T10:00:00.000Z',
      graceDays: 30,
    });
    const profile = await h.profiles.getProfile(userId);
    expect(profile.deletionRequest?.id).toBe(first.request.id);
  });

  it('uses ACCOUNT_DELETION_GRACE_DAYS for the cooling-off period', async () => {
    const h = createIdentityHarness({ identity: { ACCOUNT_DELETION_GRACE_DAYS: '14' } });
    const login = await loginMember(h);
    const result = await h.deletions.requestDeletion(login.user.id);
    expect(result).toMatchObject({
      created: true,
      graceDays: 14,
      executeAfter: '2026-03-24T10:00:00.000Z',
      request: { executeAfter: '2026-03-24T10:00:00.000Z' },
    });
    h.clock.advanceDays(13);
    await expect(h.deletions.executeDue(10)).resolves.toMatchObject({ due: 0 });
    h.clock.advanceDays(1);
    await expect(h.deletions.executeDue(10)).resolves.toMatchObject({ executed: 1 });
  });

  it('lets the member cancel during the cooling-off period', async () => {
    const { h, userId } = await memberWithData();
    await h.deletions.requestDeletion(userId);
    h.clock.advanceDays(3);
    const cancelled = await h.deletions.cancelDeletion(userId);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelledAt: '2026-03-13T10:00:00.000Z',
    });
    expect(h.store.audits.at(-1)).toMatchObject({
      actor: { type: 'user', id: userId },
      action: 'account_deletion_request.cancel',
    });
    expect(h.store.events.at(-1)).toEqual({
      aggregateType: 'user',
      aggregateId: userId,
      type: 'user.deletion_cancelled',
      payload: { userId, requestId: cancelled.id, cancelledAt: '2026-03-13T10:00:00.000Z' },
    });
    await expect(h.deletions.cancelDeletion(userId)).rejects.toMatchObject({
      code: 'PC_DELETION_NOT_PENDING',
      status: 404,
    });

    h.clock.advanceDays(ACCOUNT_DELETION_DELAY_DAYS);
    await expect(h.deletions.executeDue(10)).resolves.toMatchObject({ due: 0, executed: 0 });
    expect(h.store.state.users.get(userId)?.status).toBe('active');
  });

  it('refuses requests from blocked or unknown members', async () => {
    const h = createIdentityHarness();
    h.store.seedUser({
      id: 'u-blocked',
      phone: '+380671112233',
      memberCode: '100000009',
      status: 'blocked',
    });
    await expect(h.deletions.requestDeletion('u-blocked')).rejects.toMatchObject({
      code: 'PC_USER_BLOCKED',
    });
    await expect(h.deletions.requestDeletion('missing')).rejects.toMatchObject({
      code: 'PC_USER_NOT_FOUND',
    });
  });

  it('anonymises the account once the request is due', async () => {
    const { h, login, userId } = await memberWithData();
    const { request } = await h.deletions.requestDeletion(userId, 'bye');

    h.clock.advanceDays(ACCOUNT_DELETION_DELAY_DAYS - 1);
    await expect(h.deletions.executeDue(10)).resolves.toMatchObject({ due: 0 });

    h.clock.advanceDays(1);
    const summary = await h.deletions.executeDue(10);
    expect(summary).toEqual({ due: 1, executed: 1, skipped: 0, failed: 0, failures: [] });

    const user = h.store.state.users.get(userId);
    expect(user).toMatchObject({
      phone: anonymisedPhone(userId),
      email: null,
      firstName: null,
      lastName: null,
      birthDate: null,
      gender: null,
      city: null,
      status: 'deleted',
      memberCode: login.user.memberCode,
    });
    expect(user?.deletedAt).toEqual(h.clock.now());
    expect(h.store.state.children.size).toBe(0);
    expect(h.store.state.devices.get(login.deviceId)).toMatchObject({
      pushToken: null,
      pushEnabled: false,
      fingerprint: null,
      model: null,
      appVersion: null,
    });
    await expect(h.store.listActiveSessions(userId, h.clock.now())).resolves.toEqual([]);
    expect([...h.store.state.consents.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect([...h.store.state.otpChallenges.values()].some((row) => row.phone === TEST_PHONE)).toBe(
      false,
    );
    expect(h.store.state.deletionRequests.get(request.id)?.executedAt).toEqual(h.clock.now());
    expect(h.store.events.at(-1)).toMatchObject({
      type: 'user.deleted',
      payload: { userId, requestId: request.id, deletedAt: h.clock.now().toISOString() },
    });
    expect(h.store.audits.at(-1)).toMatchObject({
      actor: { type: 'system', id: ACCOUNT_DELETION_ACTOR },
      action: 'user.anonymise',
      entityId: userId,
      reason: 'bye',
    });
    await expect(h.sessions.refresh(login.refreshToken)).rejects.toMatchObject({
      code: 'PC_REFRESH_INVALID',
    });
  });

  it('is idempotent and lets the phone register again as a new member', async () => {
    const { h, userId } = await memberWithData();
    const { request } = await h.deletions.requestDeletion(userId);
    h.clock.advanceDays(ACCOUNT_DELETION_DELAY_DAYS);
    await h.deletions.executeDue(10);
    await expect(h.deletions.execute(request.id)).resolves.toBe('skipped');
    await expect(h.deletions.execute('missing')).resolves.toBe('skipped');

    const again = await loginMember(h);
    expect(again.isNewUser).toBe(true);
    expect(again.user.id).not.toBe(userId);
  });

  it('collects failures per request instead of stopping the run', async () => {
    const { h, userId } = await memberWithData();
    await h.deletions.requestDeletion(userId);
    h.clock.advanceDays(ACCOUNT_DELETION_DELAY_DAYS);
    jest.spyOn(h.deletions, 'execute').mockRejectedValueOnce(new Error('database hiccup'));
    const summary = await h.deletions.executeDue(10);
    expect(summary).toMatchObject({ due: 1, executed: 0, failed: 1 });
    expect(summary.failures[0]?.error).toBe('database hiccup');
  });

  it('purges old OTP challenges and dead refresh tokens', async () => {
    const h = createIdentityHarness();
    const login = await loginMember(h);
    await h.sessions.refresh(login.refreshToken);
    h.clock.advanceDays(10);
    await h.auth.requestOtp({ phone: '+380671112233', ip: TEST_IP });

    h.clock.advanceDays(51);
    const result = await h.deletions.purge({ otpDays: 7, refreshDays: 60 });
    expect(result).toEqual({ otpChallenges: 2, refreshTokens: 1 });
    expect(h.store.state.refreshTokens.size).toBe(1);
  });
});
