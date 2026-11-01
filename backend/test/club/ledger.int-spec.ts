import { uuidv7 } from 'uuidv7';
import { getValidatedEnv } from '../../src/common/config';
import type { AdminAuditPort } from '../../src/common/contracts/admin';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FakeClock } from '../../src/common/time/clock';
import { ClubJobsService } from '../../src/modules/club/services/club-jobs.service';
import { LedgerService } from '../../src/modules/club/services/ledger.service';
import { PrismaClubRepository } from '../../src/modules/club/services/prisma-club.repository';
import { RuleSetsService } from '../../src/modules/club/services/rule-sets.service';
import { describeWithDb, resetDatabase } from '../utils/int';

/**
 * Points ledger against PostgreSQL (brief section 7): row locks, the append-only trigger,
 * outbox rows in the same transaction, rollback with the caller's transaction, concurrency.
 * Self-skips without DATABASE_URL; CI runs it after `prisma migrate deploy`.
 */
describeWithDb('club ledger (PostgreSQL)', () => {
  let prisma: PrismaService;
  let clock: FakeClock;
  let ledger: LedgerService;
  let jobs: ClubJobsService;
  let repo: PrismaClubRepository;
  let userId: string;
  let memberSeq = 100000000;

  const audit: AdminAuditPort = { audit: async () => uuidv7() };

  async function createUser(): Promise<string> {
    const id = uuidv7();
    memberSeq += 1;
    await prisma.user.create({
      data: { id, phone: `+380${String(memberSeq).slice(-9)}`, memberCode: String(memberSeq) },
    });
    return id;
  }

  async function balances(forUser = userId) {
    const account = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { userId: forUser } });
    const ledgerSums = await repo.recomputeBalances(account.id);
    const buckets = await repo.sumBuckets(account.id);
    return { account, ledgerSums, buckets };
  }

  async function expectConsistent(forUser = userId): Promise<void> {
    const { account, ledgerSums, buckets } = await balances(forUser);
    expect({ available: account.availableBalance, pending: account.pendingBalance }).toEqual(
      ledgerSums,
    );
    expect(buckets).toBe(Math.max(ledgerSums.available, 0));
  }

  beforeAll(async () => {
    prisma = new PrismaService(getValidatedEnv());
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    clock = new FakeClock('2026-11-01T10:00:00.000Z');
    repo = new PrismaClubRepository(prisma);
    const ruleSets = new RuleSetsService(repo, clock, audit);
    const outbox = new OutboxService(prisma, clock);
    ledger = new LedgerService(repo, ruleSets, outbox, clock);
    jobs = new ClubJobsService(repo, ledger, ruleSets, outbox, clock);
    userId = await createUser();
    // Registered long ago: the newcomer lock is over.
    await ledger.ensureAccount(userId, new Date('2026-01-01T00:00:00.000Z'));
  });

  it('credits, spends FIFO and writes outbox rows in the same transaction', async () => {
    const first = await ledger.credit({
      userId,
      amount: 50,
      sourceType: 'receipt',
      idempotencyKey: 'receipt:1',
    });
    clock.set('2026-12-01T10:00:00.000Z');
    await ledger.credit({
      userId,
      amount: 100,
      sourceType: 'receipt',
      idempotencyKey: 'receipt:2',
    });

    const spent = await ledger.spend({
      userId,
      amount: 70,
      sourceType: 'redemption',
      idempotencyKey: 'redemption:1',
    });

    expect(spent.amount).toBe(-70);
    const rows = await prisma.pointsExpiryBucket.findMany({ orderBy: { expiresOn: 'asc' } });
    expect(rows.map((row) => [row.expiresOn.toISOString().slice(0, 10), row.remaining])).toEqual([
      ['2027-12-01', 80],
    ]);
    expect((await ledger.getEntry(first.id))?.state).toBe('spent');
    const events = await prisma.outboxEvent.findMany({ orderBy: { occurredAt: 'asc' } });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['points.account_created', 'points.credited', 'points.spent']),
    );
    await expectConsistent();
  });

  it('replays by idempotency key and rolls back with the caller transaction', async () => {
    const first = await ledger.credit({
      userId,
      amount: 30,
      sourceType: 'promo',
      idempotencyKey: 'k',
    });
    const replay = await ledger.credit({
      userId,
      amount: 30,
      sourceType: 'promo',
      idempotencyKey: 'k',
    });
    expect(replay.id).toBe(first.id);

    await expect(
      prisma.withTx(async (tx) => {
        await ledger.credit({ userId, amount: 40, sourceType: 'promo', idempotencyKey: 'k2' }, tx);
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');

    expect(await prisma.pointsTransaction.count({ where: { idempotencyKey: 'k2' } })).toBe(0);
    expect((await balances()).account.availableBalance).toBe(30);
    await expectConsistent();
  });

  it('serialises concurrent spends with SELECT ... FOR UPDATE', async () => {
    await ledger.credit({ userId, amount: 100, sourceType: 'receipt', idempotencyKey: 'r' });

    const results = await Promise.allSettled([
      ledger.spend({ userId, amount: 60, sourceType: 'redemption', idempotencyKey: 's1' }),
      ledger.spend({ userId, amount: 60, sourceType: 'redemption', idempotencyKey: 's2' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
      code: 'PC_POINTS_INSUFFICIENT',
    });
    expect((await balances()).account.availableBalance).toBe(40);
    await expectConsistent();
  });

  it('collapses concurrent credits with the same key into one row', async () => {
    const input = { userId, amount: 25, sourceType: 'receipt' as const, idempotencyKey: 'same' };
    const [a, b] = await Promise.all([ledger.credit(input), ledger.credit(input)]);
    expect(a.id).toBe(b.id);
    expect(await prisma.pointsTransaction.count({ where: { idempotencyKey: 'same' } })).toBe(1);
    await expectConsistent();
  });

  it('holds, releases, reverses into a negative balance and refunds', async () => {
    const held = await ledger.hold({
      userId,
      amount: 200,
      sourceType: 'receipt',
      idempotencyKey: 'receipt:big',
      availableAt: new Date('2026-11-08T10:00:00.000Z'),
    });
    clock.set('2026-11-08T11:00:00.000Z');
    expect(await jobs.releaseDueHolds()).toEqual({ released: 1, failed: 0 });
    expect((await ledger.getEntry(held.id))?.state).toBe('available');

    const spent = await ledger.spend({
      userId,
      amount: 150,
      sourceType: 'redemption',
      idempotencyKey: 'redemption:1',
    });
    const reversal = await ledger.reverse({
      txId: held.id,
      idempotencyKey: 'refund:1',
      reason: 'Повернення товару',
    });
    expect(reversal.amount).toBe(-200);
    expect((await balances()).account.availableBalance).toBe(-150);
    await expect(
      ledger.spend({ userId, amount: 1, sourceType: 'redemption', idempotencyKey: 'redemption:2' }),
    ).rejects.toMatchObject({ code: 'PC_POINTS_ACCOUNT_NEGATIVE' });

    const refund = await ledger.reverse({
      txId: spent.id,
      idempotencyKey: 'voucher-cancel:1',
      reason: 'Ваучер скасовано',
    });
    expect(refund).toMatchObject({ type: 'refund', amount: 150 });
    expect((await balances()).account.availableBalance).toBe(0);
    await expectConsistent();
  });

  it('expires FIFO buckets and keeps the ledger consistent', async () => {
    await ledger.credit({
      userId,
      amount: 40,
      type: 'adjust',
      sourceType: 'manual',
      idempotencyKey: 'a',
      expiresAt: new Date('2026-11-20T10:00:00.000Z'),
    });
    await ledger.credit({ userId, amount: 60, sourceType: 'receipt', idempotencyKey: 'b' });
    await ledger.spend({ userId, amount: 10, sourceType: 'redemption', idempotencyKey: 's' });

    clock.set('2026-11-21T01:30:00.000Z');
    const result = await ledger.expire();

    expect(result).toMatchObject({ buckets: 1, points: 30, failed: 0 });
    expect((await balances()).account.availableBalance).toBe(60);
    expect(await ledger.expire()).toMatchObject({ buckets: 0, points: 0 });
    expect(await jobs.checkBalanceDrift()).toMatchObject({ drifted: 0 });
    await expectConsistent();
  });

  it('refunds a spend into its original buckets and expires past ones (allocations in PG)', async () => {
    await ledger.credit({ userId, amount: 50, sourceType: 'receipt', idempotencyKey: 'r1' });
    clock.set('2026-12-10T10:00:00.000Z');
    await ledger.credit({ userId, amount: 50, sourceType: 'receipt', idempotencyKey: 'r2' });
    const spent = await ledger.spend({
      userId,
      amount: 80,
      sourceType: 'redemption',
      idempotencyKey: 'redemption:1',
      title: 'Обмін на винагороду',
      subtitle: 'Кава з собою',
      counterparty: { rewardTitle: 'Кава з собою' },
    });
    const allocations = await prisma.pointsSpendAllocation.findMany({
      where: { spendTxId: spent.id },
      orderBy: { expiresOn: 'asc' },
    });
    expect(
      allocations.map((row) => [row.expiresOn.toISOString().slice(0, 10), row.amount]),
    ).toEqual([
      ['2027-11-01', 50],
      ['2027-12-10', 30],
    ]);
    const stored = await prisma.pointsTransaction.findUniqueOrThrow({ where: { id: spent.id } });
    expect(stored).toMatchObject({
      title: 'Обмін на винагороду',
      subtitle: 'Кава з собою',
      counterparty: { rewardTitle: 'Кава з собою' },
    });

    // Day 2027-11-01 is over; 2027-12-10 is still valid.
    clock.set('2027-11-20T10:00:00.000Z');
    const refund = await ledger.reverse({
      txId: spent.id,
      idempotencyKey: 'voucher-cancel:1',
      reason: 'Ваучер скасовано',
    });
    expect(refund).toMatchObject({ type: 'refund', amount: 80, state: 'available' });
    const expiredRow = await prisma.pointsTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `reverse:${spent.id}:expire` },
    });
    expect(expiredRow).toMatchObject({ type: 'expire', amount: -50, state: 'expired' });
    const buckets = await prisma.pointsExpiryBucket.findMany({ orderBy: { expiresOn: 'asc' } });
    expect(buckets.map((row) => [row.expiresOn.toISOString().slice(0, 10), row.remaining])).toEqual(
      [['2027-12-10', 50]],
    );
    expect((await balances()).account.availableBalance).toBe(50);
    await expectConsistent();

    // Display columns and allocations are immutable.
    await expect(
      prisma.pointsTransaction.update({ where: { id: spent.id }, data: { title: 'x' } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.pointsSpendAllocation.deleteMany({ where: { spendTxId: spent.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('is protected by the append-only trigger', async () => {
    const entry = await ledger.credit({
      userId,
      amount: 10,
      sourceType: 'receipt',
      idempotencyKey: 'r',
    });
    await expect(
      prisma.pointsTransaction.update({ where: { id: entry.id }, data: { amount: 999 } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.pointsTransaction.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
    await prisma.pointsTransaction.update({ where: { id: entry.id }, data: { state: 'spent' } });
    await expect(
      prisma.pointsTransaction.update({ where: { id: entry.id }, data: { state: 'available' } }),
    ).rejects.toThrow(/illegal state transition/);
  });

  it('sends each expiry reminder once', async () => {
    await ledger.credit({
      userId,
      amount: 15,
      type: 'adjust',
      sourceType: 'manual',
      idempotencyKey: 'a',
      expiresAt: new Date('2026-11-08T10:00:00.000Z'),
    });
    expect(await jobs.sendExpiryReminders()).toMatchObject({ sent: 1 });
    expect(await jobs.sendExpiryReminders()).toMatchObject({ sent: 0, skipped: 1 });
    expect(await prisma.outboxEvent.count({ where: { type: 'points.expiring' } })).toBe(1);
    // Markers live in their own column; welcome_state keeps only the welcome flags.
    const row = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { userId } });
    expect(row.expiryReminders).toEqual({ '2026-11-08': [7] });
    expect(row.welcomeState).not.toHaveProperty('expiryReminders');
  });
});
