import { CLUB_EVENTS } from '../../../common/contracts/events';
import { type ClubTestKit, createClubTestKit } from '../testing/club-test-kit';

const USER = '0192f3a0-6c3e-7d2a-9c1b-000000000001';
const OTHER = '0192f3a0-6c3e-7d2a-9c1b-000000000002';
const ADMIN = '0192f3a0-6c3e-7d2a-9c1b-0000000000ad';
/** Registration far enough in the past that the newcomer lock is over. */
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'DomainError', code });
}

async function account(kit: ClubTestKit, userId = USER) {
  const found = await kit.repo.findAccountByUserId(userId);
  if (!found) {
    throw new Error(`no account for ${userId}`);
  }
  return found;
}

/** Cached balances equal the ledger sums and the buckets hold exactly the spendable points. */
async function expectConsistent(kit: ClubTestKit, userId = USER): Promise<void> {
  const acc = await account(kit, userId);
  const ledger = await kit.repo.recomputeBalances(acc.id);
  expect({ available: acc.availableBalance, pending: acc.pendingBalance }).toEqual(ledger);
  expect(await kit.repo.sumBuckets(acc.id)).toBe(Math.max(ledger.available, 0));
}

async function buckets(kit: ClubTestKit, userId = USER): Promise<Record<string, number>> {
  const acc = await account(kit, userId);
  const rows = await kit.repo.listBuckets(acc.id);
  return Object.fromEntries(rows.map((row) => [row.dayKey, row.remaining]));
}

async function veteran(kit: ClubTestKit, userId = USER): Promise<void> {
  await kit.ledger.ensureAccount(userId, LONG_AGO);
}

function credit(kit: ClubTestKit, amount: number, key: string, userId = USER) {
  return kit.ledger.credit({ userId, amount, sourceType: 'receipt', idempotencyKey: key });
}

function spend(kit: ClubTestKit, amount: number, key: string, userId = USER) {
  return kit.ledger.spend({ userId, amount, sourceType: 'redemption', idempotencyKey: key });
}

describe('LedgerService', () => {
  let kit: ClubTestKit;

  beforeEach(() => {
    kit = createClubTestKit('2026-11-01T10:00:00.000Z');
  });

  describe('credit', () => {
    it('creates the account on first use, fills the expiry bucket and publishes events', async () => {
      const entry = await credit(kit, 180, 'receipt:1');

      expect(entry).toMatchObject({
        userId: USER,
        type: 'earn',
        state: 'available',
        amount: 180,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:1',
      });
      expect(entry.availableAt).toEqual(new Date('2026-11-01T10:00:00.000Z'));
      // 12 months in Kyiv wall-clock time.
      expect(entry.expiresAt).toEqual(new Date('2027-11-01T10:00:00.000Z'));

      const acc = await account(kit);
      expect(acc).toMatchObject({ availableBalance: 180, pendingBalance: 0, lifetimeEarned: 180 });
      expect(acc.newcomerLockUntil).toEqual(new Date('2026-11-04T10:00:00.000Z'));
      expect(await buckets(kit)).toEqual({ '2027-11-01': 180 });
      expect(kit.outbox.events.map((event) => event.type)).toEqual([
        CLUB_EVENTS.accountCreated,
        CLUB_EVENTS.credited,
      ]);
      expect(kit.outbox.ofType(CLUB_EVENTS.credited)[0]?.payload).toMatchObject({
        txId: entry.id,
        amount: 180,
        state: 'available',
        availableBalance: 180,
        expiresAt: '2027-11-01T10:00:00.000Z',
      });
      await expectConsistent(kit);
    });

    it('is idempotent by key: a replay returns the same row and moves nothing', async () => {
      const first = await credit(kit, 100, 'receipt:1');
      const replay = await credit(kit, 100, 'receipt:1');

      expect(replay.id).toBe(first.id);
      expect(kit.repo.entries).toHaveLength(1);
      expect((await account(kit)).availableBalance).toBe(100);
      expect(kit.outbox.ofType(CLUB_EVENTS.credited)).toHaveLength(1);
    });

    it('rejects a key that belongs to another member', async () => {
      await credit(kit, 100, 'receipt:1');
      await expectDomainError(
        credit(kit, 100, 'receipt:1', OTHER),
        'PC_COMMON_IDEMPOTENCY_MISMATCH',
      );
    });

    it.each([0, -5, 1.5, Number.NaN])('rejects amount %p', async (amount) => {
      await expectDomainError(credit(kit, amount, 'k'), 'PC_POINTS_INVALID_AMOUNT');
      expect(kit.repo.entries).toHaveLength(0);
    });

    it('rejects an empty idempotency key and an expiry in the past', async () => {
      await expectDomainError(credit(kit, 10, ''), 'PC_COMMON_VALIDATION');
      await expectDomainError(
        kit.ledger.credit({
          userId: USER,
          amount: 10,
          sourceType: 'manual',
          idempotencyKey: 'k',
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        }),
        'PC_COMMON_VALIDATION',
      );
    });

    it('honours an explicit expiry and the credit type', async () => {
      const entry = await kit.ledger.credit({
        userId: USER,
        amount: 100,
        type: 'adjust',
        sourceType: 'manual',
        idempotencyKey: 'adjust:1',
        expiresAt: new Date('2027-01-31T12:00:00.000Z'),
        createdById: ADMIN,
        reason: 'Компенсація',
      });
      expect(entry).toMatchObject({ type: 'adjust', createdById: ADMIN, reason: 'Компенсація' });
      expect(await buckets(kit)).toEqual({ '2027-01-31': 100 });
      expect((await account(kit)).lifetimeEarned).toBe(100);
    });
  });

  describe('spend', () => {
    it('consumes the earliest-expiring buckets first (FIFO across buckets)', async () => {
      await veteran(kit);
      const a = await credit(kit, 50, 'a');
      kit.clock.set('2026-12-01T10:00:00.000Z');
      const b = await credit(kit, 100, 'b');
      kit.clock.set('2027-01-01T10:00:00.000Z');
      await credit(kit, 30, 'c');
      expect(await buckets(kit)).toEqual({ '2027-11-01': 50, '2027-12-01': 100, '2028-01-01': 30 });

      const entry = await spend(kit, 120, 'redemption:1');

      expect(entry).toMatchObject({ type: 'spend', state: 'spent', amount: -120, expiresAt: null });
      expect(await buckets(kit)).toEqual({ '2027-12-01': 30, '2028-01-01': 30 });
      expect((await account(kit)).availableBalance).toBe(60);
      // The emptied bucket's credit is fully consumed; the partly used one stays available.
      expect((await kit.ledger.getEntry(a.id))?.state).toBe('spent');
      expect((await kit.ledger.getEntry(b.id))?.state).toBe('available');
      expect(kit.outbox.ofType(CLUB_EVENTS.spent)[0]?.payload).toMatchObject({
        txId: entry.id,
        amount: 120,
        sourceType: 'redemption',
        availableBalance: 60,
      });
      await expectConsistent(kit);
    });

    it('rejects spending more than the available balance and changes nothing', async () => {
      await veteran(kit);
      await credit(kit, 60, 'a');
      await expect(spend(kit, 61, 's')).rejects.toMatchObject({
        code: 'PC_POINTS_INSUFFICIENT',
        status: 422,
        details: { available: 60, required: 61 },
      });
      expect((await account(kit)).availableBalance).toBe(60);
      expect(await buckets(kit)).toEqual({ '2027-11-01': 60 });
      expect(kit.repo.entries).toHaveLength(1);
    });

    it('treats a member without an account as having no points', async () => {
      await expectDomainError(spend(kit, 1, 's'), 'PC_POINTS_INSUFFICIENT');
    });

    it('is idempotent by key', async () => {
      await veteran(kit);
      await credit(kit, 100, 'a');
      const first = await spend(kit, 40, 'redemption:1');
      const replay = await spend(kit, 40, 'redemption:1');
      expect(replay.id).toBe(first.id);
      expect((await account(kit)).availableBalance).toBe(60);
      expect(kit.outbox.ofType(CLUB_EVENTS.spent)).toHaveLength(1);
    });

    it('rejects a credit key reused for a spend', async () => {
      await veteran(kit);
      await credit(kit, 100, 'shared-key');
      await expectDomainError(spend(kit, 10, 'shared-key'), 'PC_COMMON_IDEMPOTENCY_MISMATCH');
    });

    it('blocks spending during the newcomer lock and allows it afterwards', async () => {
      await credit(kit, 100, 'a');
      await expect(spend(kit, 10, 's')).rejects.toMatchObject({
        code: 'PC_POINTS_NEWCOMER_LOCK',
        details: { newcomerLockUntil: '2026-11-04T10:00:00.000Z' },
      });
      expect((await kit.ledger.getBalance(USER))?.spendBlockedBy).toBe('newcomer_lock');

      kit.clock.advanceHours(73);
      await expect(spend(kit, 10, 's')).resolves.toMatchObject({ amount: -10 });
      expect((await kit.ledger.getBalance(USER))?.spendBlockedBy).toBeNull();
    });

    it('lifts the newcomer lock at the second credited receipt', async () => {
      await kit.ledger.credit({
        userId: USER,
        amount: 50,
        type: 'welcome',
        sourceType: 'system',
        idempotencyKey: 'welcome:register',
      });
      await credit(kit, 30, 'receipt:1');
      expect((await kit.ledger.getBalance(USER))?.spendBlockedBy).toBe('newcomer_lock');

      kit.clock.advanceMinutes(10);
      await credit(kit, 40, 'receipt:2');
      expect((await account(kit)).newcomerLockUntil).toEqual(kit.clock.now());
      await expect(spend(kit, 100, 's')).resolves.toMatchObject({ amount: -100 });
    });

    it('lets a back-office deduction through the newcomer lock as a negative adjustment', async () => {
      await credit(kit, 100, 'a');
      const entry = await kit.ledger.spend({
        userId: USER,
        amount: 30,
        sourceType: 'manual',
        idempotencyKey: 'adjustment:1',
        createdById: ADMIN,
        reason: 'Помилкове нарахування',
      });
      expect(entry).toMatchObject({ type: 'adjust', amount: -30, createdById: ADMIN });
      expect((await account(kit)).availableBalance).toBe(70);
      await expectConsistent(kit);
    });
  });

  describe('hold and release', () => {
    it('keeps a hold pending until release, then makes it available with its own expiry', async () => {
      const availableAt = new Date('2026-11-08T10:00:00.000Z');
      const held = await kit.ledger.hold({
        userId: USER,
        amount: 200,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:big',
        availableAt,
      });
      expect(held).toMatchObject({ state: 'pending', amount: 200, availableAt });
      expect(held.expiresAt).toEqual(new Date('2027-11-08T10:00:00.000Z'));
      expect(await account(kit)).toMatchObject({
        availableBalance: 0,
        pendingBalance: 200,
        lifetimeEarned: 0,
      });
      expect(await buckets(kit)).toEqual({});
      expect(kit.outbox.ofType(CLUB_EVENTS.held)[0]?.payload).toMatchObject({
        state: 'pending',
        availableAt: '2026-11-08T10:00:00.000Z',
      });

      kit.clock.set(availableAt);
      const released = await kit.ledger.release(held.id);
      expect(released).toMatchObject({ id: held.id, state: 'available' });
      expect(await account(kit)).toMatchObject({
        availableBalance: 200,
        pendingBalance: 0,
        lifetimeEarned: 200,
      });
      expect(await buckets(kit)).toEqual({ '2027-11-08': 200 });
      expect(kit.outbox.ofType(CLUB_EVENTS.released)[0]?.payload).toMatchObject({
        txId: held.id,
        amount: 200,
        availableBalance: 200,
      });

      const again = await kit.ledger.release(held.id);
      expect(again.state).toBe('available');
      expect((await account(kit)).availableBalance).toBe(200);
      expect(kit.outbox.ofType(CLUB_EVENTS.released)).toHaveLength(1);
      await expectConsistent(kit);
    });

    it('replays a hold by key', async () => {
      const input = {
        userId: USER,
        amount: 90,
        sourceType: 'receipt' as const,
        idempotencyKey: 'receipt:h',
        availableAt: new Date('2026-11-08T10:00:00.000Z'),
      };
      const first = await kit.ledger.hold(input);
      const replay = await kit.ledger.hold(input);
      expect(replay.id).toBe(first.id);
      expect((await account(kit)).pendingBalance).toBe(90);
    });

    it('cancels a pending hold on reverse and refuses to release it afterwards', async () => {
      const held = await kit.ledger.hold({
        userId: USER,
        amount: 150,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:h',
        availableAt: new Date('2026-11-08T10:00:00.000Z'),
      });
      const cancelled = await kit.ledger.reverse({
        txId: held.id,
        idempotencyKey: 'receipt-refund:1',
        reason: 'Повернення товару',
      });
      expect(cancelled).toMatchObject({ id: held.id, state: 'cancelled' });
      expect(await account(kit)).toMatchObject({ availableBalance: 0, pendingBalance: 0 });
      expect(kit.outbox.ofType(CLUB_EVENTS.reversed)[0]?.payload).toMatchObject({
        reversedTxId: held.id,
        amount: 0,
        pendingAmount: 150,
      });

      const again = await kit.ledger.reverse({
        txId: held.id,
        idempotencyKey: 'receipt-refund:2',
        reason: 'x',
      });
      expect(again).toMatchObject({ id: held.id, state: 'cancelled' });
      await expectDomainError(kit.ledger.release(held.id), 'PC_POINTS_INVALID_TRANSITION');
      await expectConsistent(kit);
    });

    it('answers PC_POINTS_TX_NOT_FOUND for an unknown row', async () => {
      await expectDomainError(
        kit.ledger.release('0192f3a0-6c3e-7d2a-9c1b-0000000000ff'),
        'PC_POINTS_TX_NOT_FOUND',
      );
    });
  });

  describe('reverse', () => {
    it('takes back a partly spent credit, driving the balance negative and blocking spending', async () => {
      await veteran(kit);
      const earned = await credit(kit, 100, 'receipt:1');
      await spend(kit, 80, 'redemption:1');

      const reversal = await kit.ledger.reverse({
        txId: earned.id,
        idempotencyKey: 'receipt-refund:1',
        reason: 'Чек повернуто',
        createdById: ADMIN,
      });

      expect(reversal).toMatchObject({
        type: 'reverse',
        state: 'spent',
        amount: -100,
        sourceType: 'receipt',
        idempotencyKey: `reverse:${earned.id}`,
        createdById: ADMIN,
      });
      expect(await account(kit)).toMatchObject({ availableBalance: -80, lifetimeEarned: 0 });
      expect(await buckets(kit)).toEqual({});
      expect((await kit.ledger.getEntry(earned.id))?.state).toBe('spent');
      expect((await kit.ledger.getBalance(USER))?.spendBlockedBy).toBe('negative_balance');
      expect(kit.outbox.ofType(CLUB_EVENTS.reversed)[0]?.payload).toMatchObject({
        txId: reversal.id,
        reversedTxId: earned.id,
        amount: -100,
        pendingAmount: 0,
        availableBalance: -80,
      });
      await expectDomainError(spend(kit, 1, 'redemption:2'), 'PC_POINTS_ACCOUNT_NEGATIVE');
      await expectConsistent(kit);

      // New credits settle the debt first; only the remainder becomes spendable.
      await credit(kit, 50, 'receipt:2');
      expect((await account(kit)).availableBalance).toBe(-30);
      expect(await buckets(kit)).toEqual({});
      await credit(kit, 100, 'receipt:3');
      expect((await account(kit)).availableBalance).toBe(70);
      expect(await buckets(kit)).toEqual({ '2027-11-01': 70 });
      await expect(spend(kit, 70, 'redemption:3')).resolves.toMatchObject({ amount: -70 });
      await expectConsistent(kit);
    });

    it('reverses a credit once, whatever key the caller sends', async () => {
      await veteran(kit);
      const earned = await credit(kit, 100, 'receipt:1');
      const first = await kit.ledger.reverse({
        txId: earned.id,
        idempotencyKey: 'k1',
        reason: 'r',
      });
      const second = await kit.ledger.reverse({
        txId: earned.id,
        idempotencyKey: 'k2',
        reason: 'r',
      });
      expect(second.id).toBe(first.id);
      expect((await account(kit)).availableBalance).toBe(0);
      await expectConsistent(kit);
    });

    it('regression: redeem-then-cancel keeps the original 12-month expiry', async () => {
      await veteran(kit);
      await credit(kit, 100, 'receipt:1');
      const spent = await spend(kit, 60, 'redemption:1');
      expect(kit.repo.allocations.get(spent.id)).toEqual([{ dayKey: '2027-11-01', amount: 60 }]);
      kit.clock.set('2027-02-15T10:00:00.000Z');

      const refund = await kit.ledger.reverse({
        txId: spent.id,
        idempotencyKey: 'voucher-cancel:1',
        reason: 'Ваучер скасовано',
        title: 'Повернення балів',
        subtitle: 'Скасовано ваучер «Кава з собою»',
      });

      expect(refund).toMatchObject({
        type: 'refund',
        state: 'available',
        amount: 60,
        sourceType: 'redemption',
        title: 'Повернення балів',
        subtitle: 'Скасовано ваучер «Кава з собою»',
      });
      // Back into the bucket the spend consumed (Kyiv day 2027-11-01), not now + 12 months.
      expect(refund.expiresAt).toEqual(new Date('2027-11-01T21:59:59.999Z'));
      expect(await account(kit)).toMatchObject({ availableBalance: 100, lifetimeEarned: 100 });
      expect(await buckets(kit)).toEqual({ '2027-11-01': 100 });

      const replay = await kit.ledger.reverse({
        txId: spent.id,
        idempotencyKey: 'voucher-cancel:2',
        reason: 'x',
      });
      expect(replay.id).toBe(refund.id);
      await expectConsistent(kit);

      // The refunded points expire with the rest of that day's points.
      kit.clock.set('2027-11-02T01:30:00.000Z');
      expect(await kit.ledger.expire()).toMatchObject({ points: 100 });
      expect(await account(kit)).toMatchObject({ availableBalance: 0 });
    });

    it('returns a spend that crossed several buckets to each of them', async () => {
      await veteran(kit);
      await credit(kit, 50, 'receipt:1');
      kit.clock.set('2026-12-10T10:00:00.000Z');
      await credit(kit, 50, 'receipt:2');
      const spent = await spend(kit, 80, 'redemption:1');
      expect(await buckets(kit)).toEqual({ '2027-12-10': 20 });
      expect(kit.repo.allocations.get(spent.id)).toEqual([
        { dayKey: '2027-11-01', amount: 50 },
        { dayKey: '2027-12-10', amount: 30 },
      ]);

      kit.clock.set('2027-01-20T10:00:00.000Z');
      const refund = await kit.ledger.reverse({
        txId: spent.id,
        idempotencyKey: 'voucher-cancel:1',
        reason: 'r',
      });
      expect(await buckets(kit)).toEqual({ '2027-11-01': 50, '2027-12-10': 50 });
      expect(refund.expiresAt).toEqual(new Date('2027-11-01T21:59:59.999Z'));
      expect(refund.title).toBe('Повернення балів');
      await expectConsistent(kit);
    });

    it('expires at once the refunded portions whose day already passed (refund + expire rows)', async () => {
      await veteran(kit);
      await credit(kit, 100, 'receipt:1');
      const spent = await spend(kit, 60, 'redemption:1');
      kit.clock.set('2027-11-02T01:30:00.000Z');
      await kit.ledger.expire();
      expect(await account(kit)).toMatchObject({ availableBalance: 0 });
      kit.outbox.clear();

      kit.clock.set('2027-11-05T12:00:00.000Z');
      const refund = await kit.ledger.reverse({
        txId: spent.id,
        idempotencyKey: 'voucher-cancel:1',
        reason: 'Ваучер скасовано',
      });

      expect(refund).toMatchObject({ type: 'refund', amount: 60, state: 'expired' });
      const history = await kit.accounts.listTransactions(USER, { limit: 2 });
      expect(history.items.map((item) => [item.type, item.amount, item.title])).toEqual([
        ['expire', -60, 'Бали згоріли'],
        ['refund', 60, 'Повернення балів'],
      ]);
      expect(history.items[0]).toMatchObject({
        idempotencyKey: `reverse:${spent.id}:expire`,
        subtitle: 'Термін дії повернених балів уже минув',
      });
      expect(await account(kit)).toMatchObject({ availableBalance: 0 });
      expect(await buckets(kit)).toEqual({});
      expect(kit.outbox.events.map((event) => event.type)).toEqual([
        'points.reversed',
        'points.expired',
      ]);
      expect(kit.outbox.ofType(CLUB_EVENTS.expired)[0]?.payload).toMatchObject({
        points: 60,
        expiredOn: '2027-11-01',
        availableBalance: 0,
      });
      await expectConsistent(kit);
    });

    it('splits a refund into still valid and already expired portions', async () => {
      await veteran(kit);
      await credit(kit, 50, 'receipt:1');
      kit.clock.set('2026-12-10T10:00:00.000Z');
      await credit(kit, 50, 'receipt:2');
      const spent = await spend(kit, 80, 'redemption:1');

      kit.clock.set('2027-11-20T10:00:00.000Z');
      await kit.ledger.expire();
      const refund = await kit.ledger.reverse({
        txId: spent.id,
        idempotencyKey: 'voucher-cancel:1',
        reason: 'r',
      });
      // 50 of 2027-11-01 expired at once, 30 return to 2027-12-10 (which still holds 20).
      expect(refund).toMatchObject({ amount: 80, state: 'available' });
      expect(refund.expiresAt).toEqual(new Date('2027-12-10T21:59:59.999Z'));
      expect(await buckets(kit)).toEqual({ '2027-12-10': 50 });
      expect(await account(kit)).toMatchObject({ availableBalance: 50 });
      await expectConsistent(kit);
    });

    it('settles a negative balance first, with the earliest-expiring portions', async () => {
      await veteran(kit);
      const earned = await credit(kit, 100, 'receipt:1');
      const spent = await spend(kit, 60, 'redemption:1');
      await kit.ledger.reverse({
        txId: earned.id,
        idempotencyKey: 'receipt-cancel:1',
        reason: 'r',
      });
      expect(await account(kit)).toMatchObject({ availableBalance: -60 });

      await kit.ledger.reverse({ txId: spent.id, idempotencyKey: 'voucher-cancel:1', reason: 'r' });
      expect(await account(kit)).toMatchObject({ availableBalance: 0 });
      expect(await buckets(kit)).toEqual({});
      await expectConsistent(kit);
    });

    it('gives debits posted before allocations existed a fresh expiry (legacy rows)', async () => {
      await veteran(kit);
      await credit(kit, 100, 'receipt:1');
      const spent = await spend(kit, 60, 'redemption:1');
      kit.repo.allocations.delete(spent.id);
      kit.clock.set('2027-02-15T10:00:00.000Z');

      const refund = await kit.ledger.reverse({
        txId: spent.id,
        idempotencyKey: 'voucher-cancel:1',
        reason: 'r',
      });
      expect(refund.expiresAt).toEqual(new Date('2028-02-15T10:00:00.000Z'));
      expect(await buckets(kit)).toEqual({ '2027-11-01': 40, '2028-02-15': 60 });
      await expectConsistent(kit);
    });

    it('records the buckets a reversal consumed, so refunding the reversal restores them', async () => {
      await veteran(kit);
      const earned = await credit(kit, 100, 'receipt:1');
      const reversal = await kit.ledger.reverse({
        txId: earned.id,
        idempotencyKey: 'receipt-cancel:1',
        reason: 'r',
      });
      expect(kit.repo.allocations.get(reversal.id)).toEqual([
        { dayKey: '2027-11-01', amount: 100 },
      ]);
      kit.clock.set('2027-03-01T10:00:00.000Z');
      await kit.ledger.reverse({ txId: reversal.id, idempotencyKey: 'undo:1', reason: 'r' });
      expect(await buckets(kit)).toEqual({ '2027-11-01': 100 });
      await expectConsistent(kit);
    });

    it('refuses to reverse an expired credit', async () => {
      await veteran(kit);
      const earned = await credit(kit, 10, 'receipt:1');
      kit.clock.set('2027-11-02T01:30:00.000Z');
      await kit.ledger.expire();
      await expectDomainError(
        kit.ledger.reverse({ txId: earned.id, idempotencyKey: 'k', reason: 'r' }),
        'PC_POINTS_INVALID_TRANSITION',
      );
    });
  });

  describe('expire', () => {
    it('expires the unconsumed remainder of a bucket after its Kyiv day has ended', async () => {
      await veteran(kit);
      const a = await credit(kit, 50, 'a');
      kit.clock.set('2026-12-01T10:00:00.000Z');
      await credit(kit, 30, 'b');
      await spend(kit, 20, 's');
      expect(await buckets(kit)).toEqual({ '2027-11-01': 30, '2027-12-01': 30 });

      // 23:00 Kyiv on the expiry day: not yet.
      kit.clock.set('2027-11-01T21:00:00.000Z');
      expect(await kit.ledger.expire()).toMatchObject({ buckets: 0, points: 0 });

      // 03:30 Kyiv the next day: the job's schedule.
      kit.clock.set('2027-11-02T01:30:00.000Z');
      const result = await kit.ledger.expire();

      expect(result).toEqual({
        cutoffDayKey: '2027-11-02',
        buckets: 1,
        points: 30,
        accounts: 1,
        failed: 0,
      });
      const acc = await account(kit);
      expect(acc.availableBalance).toBe(30);
      expect(await buckets(kit)).toEqual({ '2027-12-01': 30 });
      expect((await kit.ledger.getEntry(a.id))?.state).toBe('expired');
      const expiryRow = kit.repo.entries.find((entry) => entry.type === 'expire');
      expect(expiryRow).toMatchObject({
        state: 'expired',
        amount: -30,
        sourceType: 'system',
        idempotencyKey: `expire:${acc.id}:2027-11-01`,
      });
      expect(kit.outbox.ofType(CLUB_EVENTS.expired)[0]?.payload).toEqual({
        userId: USER,
        accountId: acc.id,
        points: 30,
        expiredOn: '2027-11-01',
        availableBalance: 30,
      });
      await expectConsistent(kit);

      // Rerun on the same day: nothing left to do.
      expect(await kit.ledger.expire()).toMatchObject({ buckets: 0, points: 0 });
      expect(kit.outbox.ofType(CLUB_EVENTS.expired)).toHaveLength(1);
    });

    it('marks consumed credits of the day as spent and the rest as expired', async () => {
      await veteran(kit);
      const first = await credit(kit, 50, 'a');
      kit.clock.advanceMinutes(1);
      const second = await credit(kit, 40, 'b');
      await spend(kit, 60, 's');

      kit.clock.set('2027-11-02T01:30:00.000Z');
      await kit.ledger.expire();

      expect((await kit.ledger.getEntry(first.id))?.state).toBe('spent');
      expect((await kit.ledger.getEntry(second.id))?.state).toBe('expired');
      expect((await account(kit)).availableBalance).toBe(0);
      await expectConsistent(kit);
    });

    it('expires buckets of several accounts in one run', async () => {
      await veteran(kit, USER);
      await veteran(kit, OTHER);
      await credit(kit, 10, 'a', USER);
      await credit(kit, 20, 'b', OTHER);
      kit.clock.set('2027-12-01T01:30:00.000Z');
      expect(await kit.ledger.expire()).toMatchObject({ buckets: 2, points: 30, accounts: 2 });
      await expectConsistent(kit, USER);
      await expectConsistent(kit, OTHER);
    });
  });

  describe('reads', () => {
    it('returns null balance for a member without an account', async () => {
      expect(await kit.ledger.getBalance(USER)).toBeNull();
      expect(await kit.ledger.getEntry('0192f3a0-6c3e-7d2a-9c1b-0000000000ff')).toBeNull();
    });

    it('falls back to the default rules when no rule set is stored', async () => {
      const active = await kit.ledger.getActiveRules();
      expect(active.version).toBe(0);
      expect(active.rules.pointsTtlMonths).toBe(12);
    });

    it('sums daily statistics by row kind', async () => {
      await veteran(kit);
      const earned = await credit(kit, 100, 'receipt:1');
      await kit.ledger.credit({
        userId: USER,
        amount: 50,
        type: 'welcome',
        sourceType: 'system',
        idempotencyKey: 'welcome:1',
      });
      const hold = await kit.ledger.hold({
        userId: USER,
        amount: 30,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:2',
        availableAt: new Date('2026-11-08T10:00:00.000Z'),
      });
      const cancelled = await kit.ledger.hold({
        userId: USER,
        amount: 20,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:3',
        availableAt: new Date('2026-11-08T10:00:00.000Z'),
      });
      await kit.ledger.reverse({ txId: cancelled.id, idempotencyKey: 'k', reason: 'r' });
      await spend(kit, 40, 'redemption:1');
      await kit.ledger.spend({
        userId: USER,
        amount: 10,
        sourceType: 'manual',
        idempotencyKey: 'adjustment:1',
      });
      await kit.ledger.reverse({ txId: earned.id, idempotencyKey: 'k2', reason: 'r' });
      expect(hold.state).toBe('pending');

      const stats = await kit.ledger.getDailyStats({
        from: new Date('2026-11-01T00:00:00.000Z'),
        to: new Date('2026-11-02T00:00:00.000Z'),
      });
      expect(stats).toEqual({ earned: 180, spent: 50, expired: 0, reversed: 100 });

      const empty = await kit.ledger.getDailyStats({
        from: new Date('2026-12-01T00:00:00.000Z'),
        to: new Date('2026-12-02T00:00:00.000Z'),
      });
      expect(empty).toEqual({ earned: 0, spent: 0, expired: 0, reversed: 0 });
    });
  });
});
