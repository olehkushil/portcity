import { CLUB_EVENTS } from '../../../common/contracts/events';
import { parseMemberQrPayload } from '../domain/member-qr';
import {
  TEST_MEMBER_QR_SECRET,
  type ClubTestKit,
  createClubTestKit,
} from '../testing/club-test-kit';
import { FAKE_TX } from '../testing/in-memory-club.repository';

const USER = '0192f3a0-6c3e-7d2a-9c1b-000000000001';
const RECEIPT = '0192f3a0-6c3e-7d2a-9c1b-0000000000a1';
const ADMIN = '0192f3a0-6c3e-7d2a-9c1b-0000000000ad';

describe('ClubAccountService', () => {
  let kit: ClubTestKit;

  beforeEach(() => {
    kit = createClubTestKit('2026-11-01T10:00:00.000Z');
  });

  describe('ensureAccount', () => {
    it('creates the account once with the newcomer lock counted from registration', async () => {
      const registeredAt = new Date('2026-11-01T09:00:00.000Z');
      expect(await kit.accounts.ensureAccount(USER, registeredAt)).toEqual({ created: true });
      expect(await kit.accounts.ensureAccount(USER, registeredAt)).toEqual({ created: false });

      const account = await kit.repo.findAccountByUserId(USER);
      expect(account?.newcomerLockUntil).toEqual(new Date('2026-11-04T09:00:00.000Z'));
      expect(kit.outbox.ofType(CLUB_EVENTS.accountCreated)).toHaveLength(1);
    });
  });

  describe('grantWelcome', () => {
    it('grants each welcome bonus once with the configured amounts', async () => {
      const register = await kit.accounts.grantWelcome(USER, 'register');
      const profile = await kit.accounts.grantWelcome(USER, 'profile');
      const firstReceipt = await kit.accounts.grantWelcome(USER, 'firstReceipt', {
        sourceId: RECEIPT,
      });
      const replay = await kit.accounts.grantWelcome(USER, 'register');

      expect([register.amount, profile.amount, firstReceipt.amount]).toEqual([50, 30, 20]);
      expect(replay).toEqual({ kind: 'register', granted: false, amount: 0, txId: null });

      const account = await kit.repo.findAccountByUserId(USER);
      expect(account).toMatchObject({
        availableBalance: 100,
        lifetimeEarned: 100,
        welcomeState: { register: true, profile: true, firstReceipt: true },
      });
      const rows = kit.repo.entries.map((entry) => ({
        type: entry.type,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        key: entry.idempotencyKey,
        reason: entry.reason,
      }));
      expect(rows).toEqual([
        {
          type: 'welcome',
          sourceType: 'system',
          sourceId: null,
          key: `welcome:register:${USER}`,
          reason: 'Вітальний бонус за реєстрацію',
        },
        {
          type: 'welcome',
          sourceType: 'system',
          sourceId: null,
          key: `welcome:profile:${USER}`,
          reason: 'Бонус за заповнений профіль',
        },
        {
          type: 'welcome',
          sourceType: 'receipt',
          sourceId: RECEIPT,
          key: `welcome:firstReceipt:${USER}`,
          reason: 'Бонус за перший чек',
        },
      ]);
    });

    it('does not grant twice even when the flag was lost (ledger key wins)', async () => {
      const first = await kit.accounts.grantWelcome(USER, 'register');
      const account = await kit.repo.findAccountByUserId(USER);
      await kit.repo.updateAccount(FAKE_TX, account!.id, {
        welcomeState: { register: false, profile: false, firstReceipt: false },
      });

      const second = await kit.accounts.grantWelcome(USER, 'register');
      expect(second.txId).toBe(first.txId);
      expect((await kit.repo.findAccountByUserId(USER))?.availableBalance).toBe(50);
    });

    it('only sets the flag when the bonus is configured as zero', async () => {
      await kit.ruleSets.create({ config: { welcome: { profile: 0 } } }, { adminId: ADMIN });
      const outcome = await kit.accounts.grantWelcome(USER, 'profile');
      expect(outcome).toEqual({ kind: 'profile', granted: false, amount: 0, txId: null });
      expect((await kit.repo.findAccountByUserId(USER))?.welcomeState.profile).toBe(true);
      expect(kit.repo.entries).toHaveLength(0);
    });
  });

  describe('getAccountView', () => {
    it('returns the card with the QR payload, lock and points expiring soon', async () => {
      kit.identity.add(USER, '734211800');
      await kit.accounts.grantWelcome(USER, 'register', {
        registeredAt: new Date('2026-11-01T10:00:00.000Z'),
      });
      await kit.ledger.credit({
        userId: USER,
        amount: 40,
        type: 'adjust',
        sourceType: 'manual',
        idempotencyKey: 'adjust:1',
        expiresAt: new Date('2026-11-20T10:00:00.000Z'),
      });

      const view = await kit.accounts.getAccountView(USER);

      expect(view).toMatchObject({
        userId: USER,
        balance: 90,
        pending: 0,
        lifetimeEarned: 90,
        memberCode: '734211800',
        newcomerLockUntil: new Date('2026-11-04T10:00:00.000Z'),
        spendBlockedBy: 'newcomer_lock',
        pointValueKopecks: 100,
        expiringSoon: {
          withinDays: 30,
          points: 40,
          nearest: { expiresOn: '2026-11-20', points: 40 },
        },
      });
      expect(parseMemberQrPayload(TEST_MEMBER_QR_SECRET, view.qrPayload)).toEqual({
        memberCode: '734211800',
      });
      expect(view.qrPayload).toMatch(/^PC1:734211800:[0-9a-f]{8}$/);
    });

    it('shows zeros before the account exists', async () => {
      kit.identity.add(USER, '734211801');
      const view = await kit.accounts.getAccountView(USER);
      expect(view).toMatchObject({
        accountId: null,
        balance: 0,
        pending: 0,
        spendBlockedBy: null,
        expiringSoon: { withinDays: 30, points: 0, nearest: null },
      });
    });

    it('answers 404 for an unknown or deleted member', async () => {
      await expect(kit.accounts.getAccountView(USER)).rejects.toMatchObject({
        code: 'PC_POINTS_ACCOUNT_NOT_FOUND',
        status: 404,
      });
      kit.identity.add(USER, '734211802', { status: 'deleted' });
      await expect(kit.accounts.getAccountView(USER)).rejects.toMatchObject({
        code: 'PC_POINTS_ACCOUNT_NOT_FOUND',
      });
    });

    describe('pendingModeration (RECEIPTS_PORT.getPendingSummary)', () => {
      beforeEach(() => {
        kit.identity.add(USER, '734211803');
      });

      it('shows the receipts waiting for a moderator', async () => {
        const getPendingSummary = jest.fn(async () => ({ count: 2, expectedPoints: 180 }));
        kit.ports.receipts = { getPendingSummary };
        const view = await kit.accounts.getAccountView(USER);
        expect(view.pendingModeration).toEqual({ count: 2, expectedPoints: 180 });
        expect(getPendingSummary).toHaveBeenCalledWith(USER);
      });

      it.each([
        ['the receipts module is not in the container', null],
        ['the port has no getPendingSummary yet', {}],
        [
          'the call fails (stub, outage)',
          { getPendingSummary: () => Promise.reject(new Error('501 stub')) },
        ],
        [
          'the answer is malformed',
          {
            getPendingSummary: () =>
              Promise.resolve({ count: -1, expectedPoints: Number.NaN } as never),
          },
        ],
      ])('falls back to zeros when %s', async (_name, port) => {
        kit.ports.receipts = port;
        const view = await kit.accounts.getAccountView(USER);
        expect(view.pendingModeration).toEqual({ count: 0, expectedPoints: 0 });
      });
    });
  });

  describe('listTransactions', () => {
    it('pages newest first with an opaque cursor and filters by type', async () => {
      for (let index = 1; index <= 5; index += 1) {
        await kit.ledger.credit({
          userId: USER,
          amount: index,
          sourceType: 'receipt',
          idempotencyKey: `receipt:${index}`,
        });
        kit.clock.advanceMinutes(1);
      }

      const first = await kit.accounts.listTransactions(USER, { limit: 2 });
      expect(first.items.map((item) => item.amount)).toEqual([5, 4]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await kit.accounts.listTransactions(USER, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((item) => item.amount)).toEqual([3, 2]);

      const third = await kit.accounts.listTransactions(USER, {
        limit: 2,
        cursor: second.nextCursor ?? undefined,
      });
      expect(third.items.map((item) => item.amount)).toEqual([1]);
      expect(third.nextCursor).toBeNull();

      const spends = await kit.accounts.listTransactions(USER, { type: 'spend' });
      expect(spends.items).toEqual([]);
    });

    it('returns an empty page without an account and rejects a foreign cursor', async () => {
      expect(await kit.accounts.listTransactions(USER, {})).toEqual({
        items: [],
        nextCursor: null,
      });
      await expect(
        kit.accounts.listTransactions(USER, { cursor: 'not-a-cursor' }),
      ).rejects.toMatchObject({ code: 'PC_COMMON_CURSOR_INVALID' });
    });

    it('filters by a [from, to) window and pages inside it', async () => {
      for (let day = 1; day <= 4; day += 1) {
        kit.clock.set(`2026-11-0${day}T10:00:00.000Z`);
        await kit.ledger.credit({
          userId: USER,
          amount: day,
          sourceType: 'receipt',
          idempotencyKey: `receipt:${day}`,
        });
      }
      const window = {
        from: new Date('2026-11-02T10:00:00.000Z'),
        to: new Date('2026-11-04T10:00:00.000Z'),
      };
      const first = await kit.accounts.listTransactions(USER, { ...window, limit: 1 });
      expect(first.items.map((item) => item.amount)).toEqual([3]);
      const second = await kit.accounts.listTransactions(USER, {
        ...window,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((item) => item.amount)).toEqual([2]);
      expect(second.nextCursor).toBeNull();
      expect(
        (await kit.accounts.listTransactions(USER, { from: window.to })).items.map(
          (item) => item.amount,
        ),
      ).toEqual([4]);
      await expect(
        kit.accounts.listTransactions(USER, { from: window.to, to: window.from }),
      ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    });

    it('carries the display data written at posting time', async () => {
      await kit.ledger.credit({
        userId: USER,
        amount: 180,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:1',
        title: 'Нарахування за чек',
        subtitle: 'INTERTOP, 1 поверх',
        counterparty: { tenantName: 'INTERTOP', receiptTotalKopecks: 600_000 },
      });
      await kit.accounts.grantWelcome(USER, 'register');
      const page = await kit.accounts.listTransactions(USER, {});
      expect(page.items.map((item) => [item.title, item.subtitle, item.counterparty])).toEqual([
        ['Вітальний бонус за реєстрацію', null, null],
        [
          'Нарахування за чек',
          'INTERTOP, 1 поверх',
          { tenantName: 'INTERTOP', receiptTotalKopecks: 600_000 },
        ],
      ]);
    });
  });

  describe('getTransactionsSummary', () => {
    it('sums earned, spent, expired and refunded points of a Kyiv month', async () => {
      await kit.ledger.ensureAccount(USER, new Date('2026-01-01T00:00:00.000Z'));
      // 31 Oct 22:30 UTC is already 1 Nov in Kyiv (UTC+2).
      kit.clock.set('2026-10-31T22:30:00.000Z');
      await kit.ledger.credit({
        userId: USER,
        amount: 100,
        sourceType: 'receipt',
        idempotencyKey: 'r:1',
      });
      kit.clock.set('2026-11-10T10:00:00.000Z');
      await kit.ledger.credit({
        userId: USER,
        amount: 30,
        type: 'welcome',
        sourceType: 'system',
        idempotencyKey: 'w:1',
      });
      const spent = await kit.ledger.spend({
        userId: USER,
        amount: 60,
        sourceType: 'redemption',
        idempotencyKey: 'redemption:1',
      });
      await kit.ledger.reverse({ txId: spent.id, idempotencyKey: 'cancel:1', reason: 'r' });
      await kit.ledger.spend({
        userId: USER,
        amount: 20,
        sourceType: 'manual',
        idempotencyKey: 'adjust:1',
      });
      await kit.ledger.hold({
        userId: USER,
        amount: 500,
        sourceType: 'receipt',
        idempotencyKey: 'r:held',
        availableAt: new Date('2026-11-17T10:00:00.000Z'),
      });
      // Outside the month (December in Kyiv).
      kit.clock.set('2026-11-30T22:30:00.000Z');
      await kit.ledger.credit({
        userId: USER,
        amount: 7,
        sourceType: 'receipt',
        idempotencyKey: 'r:2',
      });

      const summary = await kit.accounts.getTransactionsSummary(USER, '2026-11');
      expect(summary).toEqual({
        month: '2026-11',
        from: new Date('2026-10-31T22:00:00.000Z'),
        to: new Date('2026-11-30T22:00:00.000Z'),
        earned: 130,
        spent: 80,
        expired: 0,
        refunded: 60,
        reversed: 0,
      });
      expect((await kit.accounts.getTransactionsSummary(USER, '2026-12')).earned).toBe(7);
    });

    it('defaults to the current Kyiv month and answers zeros without an account', async () => {
      kit.clock.set('2026-11-30T22:30:00.000Z');
      expect(await kit.accounts.getTransactionsSummary(USER)).toMatchObject({
        month: '2026-12',
        earned: 0,
        spent: 0,
        expired: 0,
      });
      await expect(kit.accounts.getTransactionsSummary(USER, '2026-13')).rejects.toMatchObject({
        code: 'PC_COMMON_VALIDATION',
      });
    });
  });

  describe('getAdminAccountView', () => {
    it('includes welcome flags and buckets', async () => {
      await kit.accounts.grantWelcome(USER, 'register');
      const view = await kit.accounts.getAdminAccountView(USER);
      expect(view.balance.available).toBe(50);
      expect(view.welcomeState.register).toBe(true);
      expect(view.buckets).toEqual([
        { accountId: view.balance.accountId, dayKey: '2027-11-01', remaining: 50 },
      ]);
    });

    it('answers 404 without an account', async () => {
      await expect(kit.accounts.getAdminAccountView(USER)).rejects.toMatchObject({
        code: 'PC_POINTS_ACCOUNT_NOT_FOUND',
      });
    });
  });
});
