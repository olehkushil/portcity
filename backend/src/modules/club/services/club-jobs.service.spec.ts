import { CLUB_EVENTS } from '../../../common/contracts/events';
import { type ClubTestKit, createClubTestKit } from '../testing/club-test-kit';

const USER = '0192f3a0-6c3e-7d2a-9c1b-000000000001';
const OTHER = '0192f3a0-6c3e-7d2a-9c1b-000000000002';
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

function creditExpiring(
  kit: ClubTestKit,
  userId: string,
  amount: number,
  key: string,
  expiresAt: string,
) {
  return kit.ledger.credit({
    userId,
    amount,
    type: 'adjust',
    sourceType: 'manual',
    idempotencyKey: key,
    expiresAt: new Date(expiresAt),
  });
}

function hold(kit: ClubTestKit, amount: number, key: string, availableAt: string) {
  return kit.ledger.hold({
    userId: USER,
    amount,
    sourceType: 'receipt',
    idempotencyKey: key,
    availableAt: new Date(availableAt),
  });
}

describe('ClubJobsService', () => {
  let kit: ClubTestKit;

  beforeEach(() => {
    kit = createClubTestKit('2026-11-01T10:00:00.000Z');
  });

  describe('releaseDueHolds', () => {
    it('releases holds whose availableAt has passed and leaves the rest pending', async () => {
      const due1 = await hold(kit, 100, 'h1', '2026-11-01T09:00:00.000Z');
      const due2 = await hold(kit, 50, 'h2', '2026-11-01T10:00:00.000Z');
      const later = await hold(kit, 70, 'h3', '2026-11-08T10:00:00.000Z');

      expect(await kit.jobs.releaseDueHolds()).toEqual({ released: 2, failed: 0 });

      expect((await kit.ledger.getEntry(due1.id))?.state).toBe('available');
      expect((await kit.ledger.getEntry(due2.id))?.state).toBe('available');
      expect((await kit.ledger.getEntry(later.id))?.state).toBe('pending');
      expect(await kit.ledger.getBalance(USER)).toMatchObject({ available: 150, pending: 70 });

      expect(await kit.jobs.releaseDueHolds()).toEqual({ released: 0, failed: 0 });
    });

    it('counts a failing release once and keeps going', async () => {
      const broken = await hold(kit, 100, 'h1', '2026-11-01T09:00:00.000Z');
      await hold(kit, 50, 'h2', '2026-11-01T09:30:00.000Z');
      const original = kit.ledger.release.bind(kit.ledger);
      jest.spyOn(kit.ledger, 'release').mockImplementation(async (txId, tx) => {
        if (txId === broken.id) {
          throw new Error('boom');
        }
        return original(txId, tx);
      });

      expect(await kit.jobs.releaseDueHolds()).toEqual({ released: 1, failed: 1 });
    });
  });

  describe('sendExpiryReminders', () => {
    it('emits points.expiring 30 and 7 days ahead, once per account, day and threshold', async () => {
      await kit.ledger.ensureAccount(USER, LONG_AGO);
      await kit.ledger.ensureAccount(OTHER, LONG_AGO);
      await creditExpiring(kit, USER, 40, 'a', '2026-12-01T10:00:00.000Z');
      await creditExpiring(kit, USER, 25, 'b', '2026-11-08T10:00:00.000Z');
      await creditExpiring(kit, USER, 10, 'c', '2026-11-15T10:00:00.000Z');
      await creditExpiring(kit, OTHER, 5, 'd', '2026-12-01T12:00:00.000Z');

      const result = await kit.jobs.sendExpiryReminders();

      expect(result).toMatchObject({ todayKey: '2026-11-01', sent: 3, skipped: 0, failed: 0 });
      expect(result.targets).toEqual([
        { dayKey: '2026-12-01', daysLeft: 30, sent: 2 },
        { dayKey: '2026-11-08', daysLeft: 7, sent: 1 },
      ]);
      const payloads = kit.outbox
        .ofType(CLUB_EVENTS.expiring)
        .map((event) => event.payload)
        .map(({ userId, points, expiresOn, daysLeft }) => ({
          userId,
          points,
          expiresOn,
          daysLeft,
        }));
      expect(payloads).toEqual(
        expect.arrayContaining([
          { userId: USER, points: 40, expiresOn: '2026-12-01', daysLeft: 30 },
          { userId: OTHER, points: 5, expiresOn: '2026-12-01', daysLeft: 30 },
          { userId: USER, points: 25, expiresOn: '2026-11-08', daysLeft: 7 },
        ]),
      );
      expect((await kit.repo.findAccountByUserId(USER))?.expiryReminders).toEqual({
        '2026-11-08': [7],
        '2026-12-01': [30],
      });

      const rerun = await kit.jobs.sendExpiryReminders();
      expect(rerun).toMatchObject({ sent: 0, skipped: 3 });
      expect(kit.outbox.ofType(CLUB_EVENTS.expiring)).toHaveLength(3);
    });

    it('prunes markers of past days on the next reminder', async () => {
      await kit.ledger.ensureAccount(USER, LONG_AGO);
      await creditExpiring(kit, USER, 25, 'b', '2026-11-08T10:00:00.000Z');
      await creditExpiring(kit, USER, 30, 'c', '2026-11-10T10:00:00.000Z');
      await kit.jobs.sendExpiryReminders();

      kit.clock.set('2026-11-03T10:00:00.000Z');
      await kit.jobs.sendExpiryReminders();
      expect((await kit.repo.findAccountByUserId(USER))?.expiryReminders).toEqual({
        '2026-11-08': [7],
        '2026-11-10': [7],
      });

      kit.clock.set('2026-11-09T10:00:00.000Z');
      await creditExpiring(kit, USER, 5, 'e', '2026-11-16T10:00:00.000Z');
      await kit.jobs.sendExpiryReminders();
      expect((await kit.repo.findAccountByUserId(USER))?.expiryReminders).toEqual({
        '2026-11-10': [7],
        '2026-11-16': [7],
      });
    });
  });

  describe('checkBalanceDrift', () => {
    it('reports nothing for consistent accounts and flags a tampered one', async () => {
      await kit.ledger.ensureAccount(USER, LONG_AGO);
      await kit.ledger.credit({
        userId: USER,
        amount: 100,
        sourceType: 'receipt',
        idempotencyKey: 'a',
      });
      await kit.ledger.spend({
        userId: USER,
        amount: 30,
        sourceType: 'redemption',
        idempotencyKey: 's',
      });
      await kit.ledger.credit({
        userId: OTHER,
        amount: 10,
        sourceType: 'receipt',
        idempotencyKey: 'b',
      });

      expect(await kit.jobs.checkBalanceDrift()).toEqual({ checked: 2, drifted: 0, drifts: [] });

      const account = await kit.repo.findAccountByUserId(USER);
      const stored = kit.repo.accounts.get(account!.id)!;
      stored.availableBalance += 5;

      const result = await kit.jobs.checkBalanceDrift();
      expect(result.checked).toBe(2);
      expect(result.drifted).toBe(1);
      expect(result.drifts[0]).toMatchObject({
        accountId: account!.id,
        kinds: ['available'],
        cached: { available: 75, pending: 0 },
        ledger: { available: 70, pending: 0 },
        bucketsSum: 70,
      });
    });
  });
});
