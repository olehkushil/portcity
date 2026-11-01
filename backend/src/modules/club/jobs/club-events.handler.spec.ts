import type { OutboxJobData } from '../../../common/outbox/outbox.types';
import { type ClubTestKit, createClubTestKit } from '../testing/club-test-kit';
import { type ClubEventsDeps, handleClubEvent } from './club-events.handler';
import { CLUB_CONSUMED_EVENTS } from './job-names';

const USER = '0192f3a0-6c3e-7d2a-9c1b-000000000001';
const RECEIPT = '0192f3a0-6c3e-7d2a-9c1b-0000000000a1';

function job(type: string, payload: Record<string, unknown>): OutboxJobData {
  return {
    eventId: '0192f3a0-6c3e-7d2a-9c1b-00000000e001',
    type,
    aggregateType: 'user',
    aggregateId: USER,
    payload,
    occurredAt: '2026-11-01T09:59:00.000Z',
  };
}

function depsFor(kit: ClubTestKit): ClubEventsDeps {
  return {
    ensureAccount: (userId, registeredAt) => kit.accounts.ensureAccount(userId, registeredAt),
    grantWelcome: (userId, kind, options) => kit.accounts.grantWelcome(userId, kind, options),
    grantProfileFieldBonus: (userId, field, completedAll) =>
      kit.accounts.grantProfileFieldBonus(userId, field, completedAll),
    log: () => undefined,
  };
}

describe('handleClubEvent', () => {
  let kit: ClubTestKit;

  beforeEach(() => {
    kit = createClubTestKit('2026-11-01T10:00:00.000Z');
  });

  it('consumes exactly the registration, profile, profile-field and first-receipt events', () => {
    expect(CLUB_CONSUMED_EVENTS).toEqual([
      'user.registered',
      'user.profile_completed',
      'user.profile_field_completed',
      'receipt.credited',
    ]);
  });

  it('user.registered creates the account (lock from registeredAt) and grants 50 points', async () => {
    const outcome = await handleClubEvent(
      'user.registered',
      job('user.registered', {
        userId: USER,
        memberCode: '734211800',
        deviceId: null,
        registeredAt: '2026-11-01T09:00:00.000Z',
      }),
      depsFor(kit),
    );

    expect(outcome).toMatchObject({
      status: 'handled',
      accountCreated: true,
      welcome: { kind: 'register', granted: true, amount: 50 },
    });
    const account = await kit.repo.findAccountByUserId(USER);
    expect(account).toMatchObject({ availableBalance: 50 });
    expect(account?.newcomerLockUntil).toEqual(new Date('2026-11-04T09:00:00.000Z'));
  });

  it('is idempotent when the same event is delivered twice', async () => {
    const data = job('user.registered', {
      userId: USER,
      memberCode: '734211800',
      deviceId: null,
      registeredAt: '2026-11-01T09:00:00.000Z',
    });
    await handleClubEvent('user.registered', data, depsFor(kit));
    const second = await handleClubEvent('user.registered', data, depsFor(kit));

    expect(second).toMatchObject({
      status: 'handled',
      accountCreated: false,
      welcome: { granted: false },
    });
    expect((await kit.repo.findAccountByUserId(USER))?.availableBalance).toBe(50);
    expect(kit.repo.entries).toHaveLength(1);
  });

  it('user.profile_completed grants 30 points, even before the registration event', async () => {
    const outcome = await handleClubEvent(
      'user.profile_completed',
      job('user.profile_completed', { userId: USER, completedAt: '2026-11-01T09:30:00.000Z' }),
      depsFor(kit),
    );
    expect(outcome).toMatchObject({ welcome: { kind: 'profile', granted: true, amount: 30 } });
    expect((await kit.repo.findAccountByUserId(USER))?.availableBalance).toBe(30);
  });

  it('receipt.credited grants 20 points for the first receipt only', async () => {
    const payload = {
      receiptId: RECEIPT,
      userId: USER,
      tenantId: null,
      totalKopecks: 600000,
      pointsAwarded: 180,
      pointsTxId: '0192f3a0-6c3e-7d2a-9c1b-0000000000b1',
      pointsState: 'available',
      availableAt: null,
    };
    const notFirst = await handleClubEvent(
      'receipt.credited',
      job('receipt.credited', { ...payload, firstReceipt: false }),
      depsFor(kit),
    );
    expect(notFirst).toEqual({
      status: 'ignored',
      event: 'receipt.credited',
      reason: 'not the first receipt',
    });

    const first = await handleClubEvent(
      'receipt.credited',
      job('receipt.credited', { ...payload, firstReceipt: true }),
      depsFor(kit),
    );
    expect(first).toMatchObject({ welcome: { kind: 'firstReceipt', granted: true, amount: 20 } });
    expect(kit.repo.entries[0]).toMatchObject({ sourceType: 'receipt', sourceId: RECEIPT });
  });

  describe('user.profile_field_completed (profile bonuses)', () => {
    const fieldJob = (field: string, allFieldsCompleted = false): OutboxJobData =>
      job('user.profile_field_completed', {
        userId: USER,
        field,
        completedAt: '2026-11-01T09:40:00.000Z',
        allFieldsCompleted,
      });

    it('grants PROFILE_BONUS_PER_FIELD once per field, with a history title', async () => {
      const first = await handleClubEvent(
        'user.profile_field_completed',
        fieldJob('birthDate'),
        depsFor(kit),
      );
      expect(first).toMatchObject({
        status: 'handled',
        profileBonus: { granted: [{ kind: 'field', amount: 10 }], skipped: [] },
      });
      const again = await handleClubEvent(
        'user.profile_field_completed',
        fieldJob('birthDate'),
        depsFor(kit),
      );
      expect(again).toMatchObject({
        status: 'handled',
        profileBonus: { granted: [], skipped: [{ kind: 'field', reason: 'already_granted' }] },
      });
      expect(kit.repo.entries).toHaveLength(1);
      expect(kit.repo.entries[0]).toMatchObject({
        type: 'welcome',
        amount: 10,
        idempotencyKey: `profile-field:birthDate:${USER}`,
        title: 'Бонус за профіль',
        subtitle: 'Дата народження',
      });
    });

    it('adds PROFILE_BONUS_COMPLETE on the event that completes the profile (once)', async () => {
      await handleClubEvent('user.profile_field_completed', fieldJob('email'), depsFor(kit));
      const last = await handleClubEvent(
        'user.profile_field_completed',
        fieldJob('city', true),
        depsFor(kit),
      );
      expect(last).toMatchObject({
        profileBonus: {
          granted: [
            { kind: 'field', amount: 10 },
            { kind: 'complete', amount: 20 },
          ],
        },
      });
      // A redelivered completing event (or another field flagged complete) pays nothing twice.
      await handleClubEvent('user.profile_field_completed', fieldJob('city', true), depsFor(kit));
      expect((await kit.repo.findAccountByUserId(USER))?.availableBalance).toBe(40);
      expect(kit.repo.entries.map((entry) => entry.idempotencyKey)).toEqual([
        `profile-field:email:${USER}`,
        `profile-field:city:${USER}`,
        `profile-complete:${USER}`,
      ]);
    });

    it('accepts completedAll as an alias and honours the configured amounts', async () => {
      kit = createClubTestKit('2026-11-01T10:00:00.000Z', {
        PROFILE_BONUS_PER_FIELD: 0,
        PROFILE_BONUS_COMPLETE: 25,
      });
      const outcome = await handleClubEvent(
        'user.profile_field_completed',
        job('user.profile_field_completed', { userId: USER, field: 'gender', completedAll: true }),
        depsFor(kit),
      );
      expect(outcome).toMatchObject({
        profileBonus: { granted: [{ kind: 'complete', amount: 25 }] },
      });
      expect(kit.repo.entries).toHaveLength(1);
    });

    it('ignores unknown fields and payloads without a field', async () => {
      expect(
        await handleClubEvent(
          'user.profile_field_completed',
          fieldJob('favouriteColour'),
          depsFor(kit),
        ),
      ).toMatchObject({ status: 'ignored', reason: 'unknown profile field "favouriteColour"' });
      expect(
        await handleClubEvent(
          'user.profile_field_completed',
          job('user.profile_field_completed', { userId: USER }),
          depsFor(kit),
        ),
      ).toMatchObject({ status: 'ignored', reason: 'payload has no field' });
      expect(kit.repo.entries).toHaveLength(0);
    });
  });

  it('ignores unknown events and payloads without a user', async () => {
    expect(
      await handleClubEvent('user.blocked', job('user.blocked', { userId: USER }), depsFor(kit)),
    ).toMatchObject({ status: 'ignored' });
    expect(
      await handleClubEvent('user.registered', job('user.registered', {}), depsFor(kit)),
    ).toEqual({ status: 'ignored', event: 'user.registered', reason: 'payload has no userId' });
    expect(kit.repo.accounts.size).toBe(0);
  });

  it('falls back to occurredAt when registeredAt is missing or malformed', async () => {
    await handleClubEvent(
      'user.registered',
      job('user.registered', { userId: USER, registeredAt: 'yesterday' }),
      depsFor(kit),
    );
    expect((await kit.repo.findAccountByUserId(USER))?.newcomerLockUntil).toEqual(
      new Date('2026-11-04T09:59:00.000Z'),
    );
  });
});
