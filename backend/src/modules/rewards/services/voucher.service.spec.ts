import { uuidv7 } from 'uuidv7';
import {
  FAKE_CONTENT_LOGO_BASE,
  FAKE_TX,
  RewardsWorld,
  TEST_VOUCHER_PEPPER,
  sequenceCodes,
  tenantSummary,
} from '../../../../test/rewards/support/fakes';
import { VOUCHER_CODE_PATTERN, type IssueVoucherInput } from '../../../common/contracts/rewards';
import { activationTokenHash, parseActivationToken } from '../domain/activation';

const USER = 'user-1';

function couponInput(overrides: Partial<IssueVoucherInput> = {}): IssueVoucherInput {
  return {
    userId: USER,
    kind: 'coupon',
    title: '-20 % INTERTOP',
    subtitle: 'INTERTOP, 1 поверх',
    tenantId: 'tenant-intertop',
    expiresAt: new Date('2026-11-15T21:59:59.000Z'),
    sourceType: 'promo',
    sourceId: uuidv7(),
    meta: { discountText: '-20 %' },
    ...overrides,
  };
}

describe('VoucherService (VOUCHER_ISSUER_PORT)', () => {
  let world: RewardsWorld;

  beforeEach(() => {
    world = new RewardsWorld();
  });

  describe('issue', () => {
    it('creates an issued voucher and publishes voucher.issued', async () => {
      const input = couponInput();
      const voucher = await world.vouchers.issue(input);
      expect(voucher).toMatchObject({
        userId: USER,
        kind: 'coupon',
        title: '-20 % INTERTOP',
        subtitle: 'INTERTOP, 1 поверх',
        tenantId: 'tenant-intertop',
        status: 'issued',
        code: null,
        sourceType: 'promo',
        sourceId: input.sourceId,
        meta: { discountText: '-20 %' },
        expiresAt: input.expiresAt,
      });
      expect(world.outbox.types()).toEqual(['voucher.issued']);
      expect(world.outbox.ofType('voucher.issued')[0]?.payload).toMatchObject({
        voucherId: voucher.id,
        kind: 'coupon',
        sourceType: 'promo',
        expiresAt: '2026-11-15T21:59:59.000Z',
      });
      expect(world.prisma.transactions).toBe(1);
    });

    it('is idempotent per (sourceType, sourceId, kind)', async () => {
      const input = couponInput();
      const first = await world.vouchers.issue(input);
      const second = await world.vouchers.issue({ ...input, title: 'changed' });
      expect(second.id).toBe(first.id);
      expect(second.title).toBe('-20 % INTERTOP');
      expect(world.repo.vouchers).toHaveLength(1);
      expect(world.outbox.types()).toEqual(['voucher.issued']);
    });

    it('returns the winner of a concurrent issue for the same source without a second event', async () => {
      const input = couponInput();
      const winner = await world.vouchers.issue(input);
      // The second caller's pre-check ran before the winner committed.
      jest.spyOn(world.repo, 'findVoucherBySource').mockResolvedValueOnce(null);
      const second = await world.vouchers.issue({ ...input, title: 'changed' });
      expect(second.id).toBe(winner.id);
      expect(world.repo.vouchers).toHaveLength(1);
      expect(world.outbox.types()).toEqual(['voucher.issued']);
    });

    it('issues separate vouchers for different kinds of the same source', async () => {
      const sourceId = uuidv7();
      await world.vouchers.issue(couponInput({ sourceId, kind: 'coupon' }));
      await world.vouchers.issue(couponInput({ sourceId, kind: 'ticket', sourceType: 'promo' }));
      expect(world.repo.vouchers).toHaveLength(2);
    });

    it('joins the caller transaction instead of opening one', async () => {
      await world.vouchers.issue(couponInput(), FAKE_TX);
      expect(world.prisma.transactions).toBe(0);
      expect(world.repo.clients.every((client) => client === FAKE_TX)).toBe(true);
      expect(world.outbox.clients).toEqual([FAKE_TX]);
    });

    it('defaults optional fields to null and an empty meta', async () => {
      const voucher = await world.vouchers.issue({
        userId: USER,
        kind: 'ticket',
        title: 'Майстер-клас',
        sourceType: 'event',
        sourceId: uuidv7(),
      });
      expect(voucher).toMatchObject({ subtitle: null, tenantId: null, expiresAt: null, meta: {} });
    });
  });

  describe('read side of the port', () => {
    it('getVoucher returns the effective summary or null', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      expect(await world.vouchers.getVoucher(voucher.id)).toMatchObject({ id: voucher.id });
      expect(await world.vouchers.getVoucher(uuidv7())).toBeNull();
      world.clock.set('2026-11-16T00:00:00.000Z');
      expect((await world.vouchers.getVoucher(voucher.id))?.status).toBe('expired');
    });

    it('listBySource returns every voucher of the source', async () => {
      const sourceId = uuidv7();
      await world.vouchers.issue(couponInput({ sourceId, kind: 'ticket', sourceType: 'event' }));
      await world.vouchers.issue(couponInput());
      const list = await world.vouchers.listBySource('event', sourceId);
      expect(list.map((voucher) => voucher.kind)).toEqual(['ticket']);
    });

    it('getDailyStats counts issued, redeemed and live vouchers', async () => {
      const from = new Date('2026-11-01T00:00:00.000Z');
      const to = new Date('2026-11-02T00:00:00.000Z');
      world.seedVoucher({ status: 'issued' });
      world.seedVoucher({ status: 'redeemed', redeemedAt: new Date('2026-11-01T09:00:00.000Z') });
      world.seedVoucher({ status: 'cancelled' });
      world.seedVoucher({ status: 'issued', createdAt: new Date('2026-10-01T00:00:00.000Z') });
      expect(await world.vouchers.getDailyStats({ from, to })).toEqual({
        issued: 3,
        redeemed: 1,
        live: 2,
      });
    });
  });

  describe('activate', () => {
    it('issues a 6-character code and a signed token valid for 120 s', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      world.outbox.events = [];
      const result = await world.vouchers.activate(USER, voucher.id);

      expect(result.code).toMatch(VOUCHER_CODE_PATTERN);
      expect(result.activatedAt).toEqual(world.now());
      expect(result.activationExpiresAt).toEqual(new Date('2026-11-01T10:02:00.000Z'));
      expect(result.serverTime).toEqual(world.now());
      expect(result.voucher).toMatchObject({ status: 'active', code: result.code });

      const parsed = parseActivationToken(result.token, TEST_VOUCHER_PEPPER, world.now());
      expect(parsed).toMatchObject({ ok: true, subject: voucher.id });

      const stored = world.repo.voucher(voucher.id);
      expect(stored).toMatchObject({ status: 'active', code: result.code });
      expect(stored?.tokenHash).toBe(activationTokenHash(result.token, TEST_VOUCHER_PEPPER));
      expect(world.outbox.types()).toEqual(['voucher.activated']);
      expect(world.outbox.ofType('voucher.activated')[0]?.payload.activationExpiresAt).toBe(
        '2026-11-01T10:02:00.000Z',
      );
    });

    it('replays the same code and token inside the window without a new event', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      const first = await world.vouchers.activate(USER, voucher.id);
      world.clock.advanceSeconds(30);
      const second = await world.vouchers.activate(USER, voucher.id);
      expect(second.code).toBe(first.code);
      expect(second.token).toBe(first.token);
      expect(second.activationExpiresAt).toEqual(first.activationExpiresAt);
      expect(second.serverTime).toEqual(world.now());
      expect(world.outbox.ofType('voucher.activated')).toHaveLength(1);
    });

    it('re-activates with a new code after the window lapsed', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      world.vouchers.codeGenerator = sequenceCodes('AAAAAA', 'BBBBBB');
      const first = await world.vouchers.activate(USER, voucher.id);
      world.clock.advanceSeconds(121);
      const second = await world.vouchers.activate(USER, voucher.id);
      expect(first.code).toBe('AAAAAA');
      expect(second.code).toBe('BBBBBB');
      expect(second.activationExpiresAt).toEqual(new Date('2026-11-01T10:04:01.000Z'));
      expect(world.outbox.ofType('voucher.activated')).toHaveLength(2);
    });

    it('skips codes held by other live vouchers', async () => {
      world.seedVoucher({ userId: 'user-2', status: 'active', code: 'AAAAAA' });
      world.seedVoucher({ userId: 'user-3', status: 'issued', code: 'BBBBBB' });
      const voucher = await world.vouchers.issue(couponInput());
      world.vouchers.codeGenerator = sequenceCodes('AAAAAA', 'BBBBBB', 'CCCCCC');
      expect((await world.vouchers.activate(USER, voucher.id)).code).toBe('CCCCCC');
    });

    it('may reuse the code of a final voucher (partial unique index)', async () => {
      world.seedVoucher({ userId: 'user-2', status: 'redeemed', code: 'AAAAAA' });
      world.seedVoucher({ userId: 'user-3', status: 'expired', code: 'AAAAAA' });
      const voucher = await world.vouchers.issue(couponInput());
      world.vouchers.codeGenerator = sequenceCodes('AAAAAA');
      expect((await world.vouchers.activate(USER, voucher.id)).code).toBe('AAAAAA');
    });

    it('fails with PC_VOUCHER_CODE_EXHAUSTED when every attempt hits a live code', async () => {
      world.seedVoucher({ userId: 'user-2', status: 'active', code: 'AAAAAA' });
      const voucher = await world.vouchers.issue(couponInput());
      world.vouchers.codeGenerator = sequenceCodes('AAAAAA');
      await expect(world.vouchers.activate(USER, voucher.id)).rejects.toMatchObject({
        code: 'PC_VOUCHER_CODE_EXHAUSTED',
        status: 503,
      });
      expect(world.repo.voucher(voucher.id)?.status).toBe('issued');
    });

    it('retries the whole transaction when the unique index rejects the code', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      world.repo.codeWriteConflicts = 2;
      const result = await world.vouchers.activate(USER, voucher.id);
      expect(result.code).toMatch(VOUCHER_CODE_PATTERN);
      expect(world.prisma.rollbacks).toBe(2);
      expect(world.outbox.ofType('voucher.activated')).toHaveLength(1);
    });

    it('gives up after REWARDS_CODE_MAX_ATTEMPTS unique violations', async () => {
      world = new RewardsWorld({ config: { REWARDS_CODE_MAX_ATTEMPTS: 3 } });
      const voucher = await world.vouchers.issue(couponInput());
      world.repo.codeWriteConflicts = 10;
      await expect(world.vouchers.activate(USER, voucher.id)).rejects.toMatchObject({
        code: 'PC_VOUCHER_CODE_EXHAUSTED',
        details: { attempts: 3 },
      });
      expect(world.prisma.rollbacks).toBe(3);
    });

    it.each([
      ['redeemed', { status: 'redeemed' as const }, 'PC_VOUCHER_ALREADY_REDEEMED'],
      ['cancelled', { status: 'cancelled' as const }, 'PC_VOUCHER_FINAL'],
      ['expired', { status: 'expired' as const }, 'PC_VOUCHER_EXPIRED'],
      ['past expiresAt', { expiresAt: new Date('2026-11-01T09:00:00.000Z') }, 'PC_VOUCHER_EXPIRED'],
    ])('rejects a %s voucher', async (_name, overrides, code) => {
      const voucher = world.seedVoucher({ userId: USER, ...overrides });
      await expect(world.vouchers.activate(USER, voucher.id)).rejects.toMatchObject({ code });
      expect(world.outbox.events).toEqual([]);
    });

    it('treats a foreign or unknown voucher as not found', async () => {
      const foreign = world.seedVoucher({ userId: 'user-2' });
      await expect(world.vouchers.activate(USER, foreign.id)).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_FOUND',
        status: 404,
      });
      await expect(world.vouchers.activate(USER, uuidv7())).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_FOUND',
      });
    });
  });

  describe('wallet reads', () => {
    it('getForUser hides foreign vouchers and the code of a lapsed activation', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      const activation = await world.vouchers.activate(USER, voucher.id);
      expect((await world.vouchers.getForUser(USER, voucher.id)).code).toBe(activation.code);
      world.clock.advanceSeconds(120);
      expect(await world.vouchers.getForUser(USER, voucher.id)).toMatchObject({
        status: 'issued',
        code: null,
        activationExpiresAt: null,
      });
      await expect(world.vouchers.getForUser('user-2', voucher.id)).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_FOUND',
      });
    });

    it('listForUser filters by effective status and pages newest first', async () => {
      const base = world.now().getTime();
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        ids.push(
          world.seedVoucher({ userId: USER, createdAt: new Date(base - index * 60_000) }).id,
        );
      }
      world.seedVoucher({
        userId: USER,
        status: 'active',
        code: 'LAPSED',
        activationExpiresAt: new Date(base - 1),
      });
      world.seedVoucher({
        userId: USER,
        status: 'redeemed',
        createdAt: new Date(base - 3_600_000),
      });
      world.seedVoucher({ userId: 'user-2' });

      const first = await world.vouchers.listForUser(USER, { statuses: ['issued'], limit: 4 });
      expect(first.items).toHaveLength(4);
      expect(first.nextCursor).not.toBeNull();
      const second = await world.vouchers.listForUser(USER, {
        statuses: ['issued'],
        limit: 4,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      const all = [...first.items, ...second.items];
      expect(all.every((voucher) => voucher.status === 'issued')).toBe(true);
      expect(new Set(all.map((voucher) => voucher.id)).size).toBe(6);

      const redeemed = await world.vouchers.listForUser(USER, {
        statuses: ['redeemed'],
        limit: 10,
      });
      expect(redeemed.items).toHaveLength(1);
      const everything = await world.vouchers.listForUser(USER, { limit: 50 });
      expect(everything.items).toHaveLength(7);
    });

    it('listForUser accepts several statuses at once', async () => {
      world.seedVoucher({ userId: USER });
      world.seedVoucher({
        userId: USER,
        status: 'active',
        code: 'AAAAAA',
        activationExpiresAt: new Date('2026-11-01T10:01:00.000Z'),
      });
      world.seedVoucher({ userId: USER, status: 'redeemed' });
      world.seedVoucher({ userId: USER, expiresAt: new Date('2026-11-01T09:00:00.000Z') });
      const live = await world.vouchers.listForUser(USER, {
        statuses: ['issued', 'active'],
        limit: 10,
      });
      expect(live.items.map((voucher) => voucher.status).sort()).toEqual(['active', 'issued']);
      const finished = await world.vouchers.listForUser(USER, {
        statuses: ['redeemed', 'expired'],
        limit: 10,
      });
      expect(finished.items.map((voucher) => voucher.status).sort()).toEqual([
        'expired',
        'redeemed',
      ]);
    });

    it('summaryForUser counts effective statuses for the wallet badge', async () => {
      world.seedVoucher({ userId: USER });
      world.seedVoucher({ userId: USER });
      world.seedVoucher({
        userId: USER,
        status: 'active',
        code: 'AAAAAA',
        activationExpiresAt: new Date('2026-11-01T10:01:00.000Z'),
      });
      // A lapsed activation counts as issued, a live row past expiresAt as expired.
      world.seedVoucher({
        userId: USER,
        status: 'active',
        code: 'BBBBBB',
        activationExpiresAt: new Date('2026-11-01T09:59:00.000Z'),
      });
      world.seedVoucher({ userId: USER, expiresAt: new Date('2026-11-01T09:00:00.000Z') });
      world.seedVoucher({ userId: USER, status: 'redeemed' });
      world.seedVoucher({ userId: 'user-2' });
      expect(await world.vouchers.summaryForUser(USER)).toEqual({
        counts: { issued: 3, active: 1, redeemed: 1, expired: 1, cancelled: 0 },
        live: 4,
        total: 6,
      });
      expect(await world.vouchers.summaryForUser('nobody')).toMatchObject({ live: 0, total: 0 });
    });

    it('decorates vouchers with the tenant card, image URL and display number', async () => {
      world = new RewardsWorld({ publicBaseUrl: 'https://cdn.portcity.ua' });
      const tenant = world.content.add(tenantSummary({ logoKey: 'logos/aroma.png', floor: 1 }));
      world.seedVoucher({ userId: USER, tenantId: tenant.id, imageKey: 'rewards/coffee.webp' });
      const [view] = (await world.vouchers.listForUser(USER, { limit: 10 })).items;
      // CONTENT_PORT.getTenantSummaryById resolves the logo URL with content's own base.
      expect(view).toEqual(
        expect.objectContaining({
          tenant: {
            id: tenant.id,
            slug: 'aroma-kava',
            name: 'Aroma Kava',
            floor: 1,
            logoUrl: `${FAKE_CONTENT_LOGO_BASE}/logos/aroma.png`,
          },
          imageUrl: 'https://cdn.portcity.ua/rewards/coffee.webp',
          qrPayload: null,
        }),
      );
      expect(view?.displayNumber).toMatch(/^\d{8}$/);

      // Display lookup unavailable: batch summaries, logo URL from S3_PUBLIC_BASE_URL.
      world.content.failDisplay = true;
      expect((await world.vouchers.getForUser(USER, view?.id ?? '')).tenant).toEqual({
        id: tenant.id,
        slug: 'aroma-kava',
        name: 'Aroma Kava',
        floor: 1,
        logoUrl: 'https://cdn.portcity.ua/logos/aroma.png',
      });
      // The content module being down only drops the tenant card.
      world.content.fail = true;
      expect((await world.vouchers.getForUser(USER, view?.id ?? '')).tenant).toBeNull();
    });

    it('gives tickets and certificates a static QR while they are live', async () => {
      const ticket = world.seedVoucher({
        userId: USER,
        kind: 'ticket',
        sourceType: 'event',
        expiresAt: new Date('2026-11-08T18:00:00.000Z'),
      });
      const view = await world.vouchers.getForUser(USER, ticket.id);
      expect(view.qrPayload).toMatch(/^PCV1:/);
      expect(view.displayNumber).toBe(
        (await world.vouchers.getForUser(USER, ticket.id)).displayNumber,
      );
      world.clock.set('2026-11-08T18:00:00.000Z');
      expect((await world.vouchers.getForUser(USER, ticket.id)).qrPayload).toBeNull();
    });

    it('rejects a cursor of another list', async () => {
      const bad = Buffer.from(JSON.stringify({ sortOrder: 1, id: 'x' })).toString('base64url');
      await expect(
        world.vouchers.listForUser(USER, { limit: 10, cursor: bad }),
      ).rejects.toMatchObject({
        code: 'PC_COMMON_CURSOR_INVALID',
      });
    });
  });

  describe('cancel', () => {
    async function redeemedVoucher(): Promise<{ voucherId: string; rewardId: string }> {
      const reward = world.seedReward({ costPoints: 60, stock: 5 });
      world.ledger.setBalance(USER, 320);
      const result = await world.redemptions.redeem(USER, reward.id);
      world.outbox.events = [];
      return { voucherId: result.voucher.id, rewardId: reward.id };
    }

    it('returns the points of a redemption voucher and the stock unit', async () => {
      const { voucherId, rewardId } = await redeemedVoucher();
      expect(world.ledger.balanceOf(USER)).toBe(260);
      expect(world.repo.reward(rewardId)?.stock).toBe(4);

      const cancelled = await world.vouchers.cancelForMember(USER, voucherId, '  ');
      expect(cancelled.status).toBe('cancelled');
      expect(world.ledger.balanceOf(USER)).toBe(320);
      expect(world.ledger.reverseCalls[0]?.input).toMatchObject({
        idempotencyKey: `voucher-cancel:${voucherId}`,
        reason: 'Cancelled by the member',
      });
      expect(world.ledger.reverseCalls[0]?.tx).toBe(FAKE_TX);
      expect(world.repo.redemptions[0]?.status).toBe('refunded');
      expect(world.repo.reward(rewardId)?.stock).toBe(5);
      expect(world.outbox.ofType('voucher.cancelled')[0]?.payload).toMatchObject({
        voucherId,
        reason: 'Cancelled by the member',
        pointsRefunded: 60,
      });
    });

    it('cancels an active voucher and frees its code', async () => {
      const { voucherId } = await redeemedVoucher();
      await world.vouchers.activate(USER, voucherId);
      await world.vouchers.cancelForMember(USER, voucherId, 'changed my mind');
      expect(world.repo.voucher(voucherId)).toMatchObject({
        status: 'cancelled',
        code: null,
        tokenHash: null,
        activationExpiresAt: null,
      });
    });

    it('keeps the points when the caller opts out (refundPoints false)', async () => {
      const { voucherId, rewardId } = await redeemedVoucher();
      const cancelled = await world.vouchers.cancel({
        voucherId,
        reason: 'abuse',
        actor: { type: 'admin', id: 'admin-1' },
        refundPoints: false,
      });
      expect(cancelled.status).toBe('cancelled');
      expect(world.ledger.reverseCalls).toHaveLength(0);
      expect(world.ledger.balanceOf(USER)).toBe(260);
      expect(world.repo.redemptions[0]?.status).toBe('cancelled');
      expect(world.repo.reward(rewardId)?.stock).toBe(5);
      expect(world.outbox.ofType('voucher.cancelled')[0]?.payload.pointsRefunded).toBeNull();
    });

    it('records the admin as creator of the refund row', async () => {
      const { voucherId } = await redeemedVoucher();
      await world.vouchers.cancel({
        voucherId,
        reason: 'goodwill',
        actor: { type: 'admin', id: 'admin-1' },
      });
      expect(world.ledger.reverseCalls[0]?.input.createdById).toBe('admin-1');
    });

    it('cancels a coupon without touching the ledger', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      const cancelled = await world.vouchers.cancel({
        voucherId: voucher.id,
        reason: 'promo withdrawn',
        actor: { type: 'system', id: 'promos' },
      });
      expect(cancelled.status).toBe('cancelled');
      expect(world.ledger.reverseCalls).toHaveLength(0);
    });

    it.each([
      ['redeemed', { status: 'redeemed' as const }, 'PC_VOUCHER_ALREADY_REDEEMED'],
      ['cancelled', { status: 'cancelled' as const }, 'PC_VOUCHER_FINAL'],
      ['expired', { status: 'expired' as const }, 'PC_VOUCHER_FINAL'],
      ['past expiresAt', { expiresAt: new Date('2026-11-01T09:59:59.000Z') }, 'PC_VOUCHER_FINAL'],
    ])('refuses to cancel a %s voucher', async (_name, overrides, code) => {
      const voucher = world.seedVoucher({ userId: USER, ...overrides });
      await expect(world.vouchers.cancelForMember(USER, voucher.id)).rejects.toMatchObject({
        code,
      });
      expect(world.outbox.events).toEqual([]);
    });

    it('throws PC_VOUCHER_NOT_FOUND through the port for unknown ids', async () => {
      await expect(
        world.vouchers.cancel({ voucherId: uuidv7(), reason: 'x', actor: { type: 'system' } }),
      ).rejects.toMatchObject({ code: 'PC_VOUCHER_NOT_FOUND' });
    });

    it('rolls everything back when the ledger refund fails', async () => {
      const { voucherId } = await redeemedVoucher();
      jest.spyOn(world.ledger, 'reverse').mockRejectedValueOnce(new Error('ledger down'));
      await expect(world.vouchers.cancelForMember(USER, voucherId)).rejects.toThrow('ledger down');
      expect(world.repo.voucher(voucherId)?.status).toBe('issued');
      expect(world.repo.redemptions[0]?.status).toBe('issued');
      expect(world.outbox.events).toEqual([]);
    });
  });

  describe('activation vs cancellation (row lock + conditional writes)', () => {
    async function redeemedVoucher(): Promise<{ voucherId: string; rewardId: string }> {
      const reward = world.seedReward({ costPoints: 60, stock: 5 });
      world.ledger.setBalance(USER, 320);
      const result = await world.redemptions.redeem(USER, reward.id);
      world.outbox.events = [];
      world.callLog.length = 0;
      return { voucherId: result.voucher.id, rewardId: reward.id };
    }

    it('regression: a cancel committed between the read and the write is never undone', async () => {
      const { voucherId } = await redeemedVoucher();
      // Interleaving of the confirmed bug: activation read the voucher as `issued`, then a
      // concurrent cancellation committed (refund included) before activation wrote. The old
      // id-only update turned the cancelled voucher back into an active one.
      const readByActivation = world.repo.voucher(voucherId)!;
      await world.vouchers.cancelForMember(USER, voucherId, 'changed my mind');
      world.repo.serveStaleLockRead(readByActivation);

      await expect(world.vouchers.activate(USER, voucherId)).rejects.toMatchObject({
        code: 'PC_VOUCHER_FINAL',
        status: 409,
        details: { status: 'cancelled' },
      });
      // The voucher stays cancelled (not revived as active) and the points stay refunded.
      expect(world.repo.voucher(voucherId)).toMatchObject({
        status: 'cancelled',
        code: null,
        tokenHash: null,
      });
      expect(world.ledger.balanceOf(USER)).toBe(320);
      expect(world.outbox.types()).toEqual(['voucher.cancelled']);
    });

    it('regression: a concurrent activation is not overwritten by a second one', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      world.vouchers.codeGenerator = sequenceCodes('AAAAAA', 'BBBBBB');
      const readBySecond = world.repo.voucher(voucher.id)!;
      await world.vouchers.activate(USER, voucher.id);
      world.repo.serveStaleLockRead(readBySecond);

      await expect(world.vouchers.activate(USER, voucher.id)).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_ACTIVE',
      });
      expect(world.repo.voucher(voucher.id)).toMatchObject({ status: 'active', code: 'AAAAAA' });
      expect(world.outbox.ofType('voucher.activated')).toHaveLength(1);
    });

    it('activation then cancellation in order: the active voucher is cancelled and refunded', async () => {
      const { voucherId } = await redeemedVoucher();
      await world.vouchers.activate(USER, voucherId);
      await world.vouchers.cancelForMember(USER, voucherId);
      await expect(world.vouchers.activate(USER, voucherId)).rejects.toMatchObject({
        code: 'PC_VOUCHER_FINAL',
      });
      expect(world.repo.voucher(voucherId)?.status).toBe('cancelled');
      expect(world.ledger.balanceOf(USER)).toBe(320);
    });

    it('activation locks the voucher row before reading it', async () => {
      const voucher = await world.vouchers.issue(couponInput());
      const lock = jest.spyOn(world.repo, 'lockVoucher');
      const read = jest.spyOn(world.repo, 'findVoucherById');
      await world.vouchers.activate(USER, voucher.id);
      expect(lock).toHaveBeenCalledWith(FAKE_TX, voucher.id);
      expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
        read.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
    });

    it('cancel locks voucher -> reward -> account (ledger), the order redeem is compatible with', async () => {
      const { voucherId, rewardId } = await redeemedVoucher();
      await world.vouchers.cancelForMember(USER, voucherId);
      expect(world.callLog).toEqual([
        `voucher:${voucherId}`,
        `reward:${rewardId}`,
        'ledger.reverse',
      ]);

      // Redeem takes reward -> account, never the other way round.
      world.callLog.length = 0;
      world.ledger.setBalance(USER, 320);
      await world.redemptions.redeem(USER, rewardId);
      expect(world.callLog).toEqual([`reward:${rewardId}`, 'ledger.spend']);
    });

    it('a cancel that loses the race against a redeem reports PC_VOUCHER_ALREADY_REDEEMED', async () => {
      const { voucherId } = await redeemedVoucher();
      const readByCancel = world.repo.voucher(voucherId)!;
      world.repo.putVoucher({ ...readByCancel, status: 'redeemed', redeemedAt: world.now() });
      world.repo.serveStaleLockRead(readByCancel);
      await expect(world.vouchers.cancelForMember(USER, voucherId)).rejects.toMatchObject({
        code: 'PC_VOUCHER_ALREADY_REDEEMED',
      });
      expect(world.repo.voucher(voucherId)?.status).toBe('redeemed');
      expect(world.ledger.reverseCalls).toHaveLength(0);
      expect(world.ledger.balanceOf(USER)).toBe(260);
    });
  });

  describe('sweep transitions', () => {
    it('deactivates a lapsed activation back to issued and frees the code', async () => {
      const voucher = world.seedVoucher({
        status: 'active',
        code: 'K7M2PQ',
        tokenHash: 'hash',
        activatedAt: new Date('2026-11-01T09:57:00.000Z'),
        activationExpiresAt: new Date('2026-11-01T09:59:00.000Z'),
        expiresAt: new Date('2026-11-20T00:00:00.000Z'),
      });
      expect(await world.vouchers.applySweepAction(voucher, 'deactivate', world.now())).toBe(true);
      expect(world.repo.voucher(voucher.id)).toMatchObject({
        status: 'issued',
        code: null,
        tokenHash: null,
        activatedAt: null,
        activationExpiresAt: null,
      });
      expect(world.outbox.events).toEqual([]);
    });

    it('does not deactivate a voucher whose window is still live', async () => {
      const voucher = world.seedVoucher({
        status: 'active',
        code: 'K7M2PQ',
        activationExpiresAt: new Date('2026-11-01T10:01:00.000Z'),
      });
      expect(await world.vouchers.applySweepAction(voucher, 'deactivate', world.now())).toBe(false);
      expect(world.repo.voucher(voucher.id)?.status).toBe('active');
    });

    it('expires a voucher past expiresAt and publishes voucher.expired', async () => {
      const voucher = world.seedVoucher({ expiresAt: new Date('2026-11-01T09:00:00.000Z') });
      expect(await world.vouchers.applySweepAction(voucher, 'expire', world.now())).toBe(true);
      expect(world.repo.voucher(voucher.id)?.status).toBe('expired');
      expect(world.outbox.types()).toEqual(['voucher.expired']);
    });

    it('does not expire a voucher that was redeemed meanwhile', async () => {
      const voucher = world.seedVoucher({ expiresAt: new Date('2026-11-01T09:00:00.000Z') });
      world.repo.putVoucher({ ...voucher, status: 'redeemed' });
      expect(await world.vouchers.applySweepAction(voucher, 'expire', world.now())).toBe(false);
      expect(world.outbox.events).toEqual([]);
    });

    describe('refund on expiry (REWARDS_REFUND_ON_EXPIRY)', () => {
      async function expiredRedemptionVoucher(): Promise<{
        voucherId: string;
        rewardId: string;
      }> {
        const reward = world.seedReward({ costPoints: 60, stock: 5 });
        world.ledger.setBalance(USER, 320);
        const result = await world.redemptions.redeem(USER, reward.id);
        world.outbox.events = [];
        world.callLog.length = 0;
        // The voucher expires unused (REWARDS_VOUCHER_TTL_DAYS = 30).
        world.clock.set('2026-12-02T00:00:00.000Z');
        return { voucherId: result.voucher.id, rewardId: reward.id };
      }

      it('returns the points of an unused reward voucher and the stock unit', async () => {
        const { voucherId, rewardId } = await expiredRedemptionVoucher();
        const row = world.repo.voucher(voucherId);
        expect(row).toBeDefined();
        expect(await world.vouchers.applySweepAction(row!, 'expire', world.now())).toBe(true);

        expect(world.repo.voucher(voucherId)?.status).toBe('expired');
        expect(world.ledger.balanceOf(USER)).toBe(320);
        expect(world.ledger.reverseCalls[0]?.input).toMatchObject({
          idempotencyKey: `voucher-expire:${voucherId}`,
          reason: 'Ваучер не використано вчасно: бали повернено',
          title: 'Повернення балів',
          counterparty: { voucherId, rewardId },
        });
        expect(world.repo.redemptions[0]?.status).toBe('refunded');
        expect(world.repo.reward(rewardId)?.stock).toBe(5);
        expect(world.outbox.types()).toEqual(['voucher.expired']);
        // Lock order of the sweep: voucher (conditional update) -> reward -> account.
        expect(world.callLog).toEqual([`reward:${rewardId}`, 'ledger.reverse']);
      });

      it('is idempotent: a second sweep pass changes nothing', async () => {
        const { voucherId } = await expiredRedemptionVoucher();
        const row = world.repo.voucher(voucherId)!;
        await world.vouchers.applySweepAction(row, 'expire', world.now());
        expect(await world.vouchers.applySweepAction(row, 'expire', world.now())).toBe(false);
        expect(world.ledger.reverseCalls).toHaveLength(1);
        expect(world.ledger.balanceOf(USER)).toBe(320);
      });

      it('rolls the expiry back when the ledger refund fails, so the next sweep retries', async () => {
        const { voucherId } = await expiredRedemptionVoucher();
        const row = world.repo.voucher(voucherId)!;
        jest.spyOn(world.ledger, 'reverse').mockRejectedValueOnce(new Error('ledger down'));
        await expect(world.vouchers.applySweepAction(row, 'expire', world.now())).rejects.toThrow(
          'ledger down',
        );
        expect(world.repo.voucher(voucherId)?.status).toBe('issued');
        expect(await world.vouchers.applySweepAction(row, 'expire', world.now())).toBe(true);
        expect(world.ledger.balanceOf(USER)).toBe(320);
      });

      it('keeps the points when the option is off', async () => {
        world = new RewardsWorld({ config: { REWARDS_REFUND_ON_EXPIRY: false } });
        const { voucherId } = await expiredRedemptionVoucher();
        await world.vouchers.applySweepAction(
          world.repo.voucher(voucherId)!,
          'expire',
          world.now(),
        );
        expect(world.ledger.reverseCalls).toHaveLength(0);
        expect(world.ledger.balanceOf(USER)).toBe(260);
        expect(world.repo.redemptions[0]?.status).toBe('issued');
      });

      it.each([
        ['promo coupon', { kind: 'coupon' as const, sourceType: 'promo' as const }],
        ['event ticket', { kind: 'ticket' as const, sourceType: 'event' as const }],
        ['admin certificate', { kind: 'certificate' as const, sourceType: 'admin' as const }],
      ])('never refunds a %s', async (_name, overrides) => {
        const voucher = world.seedVoucher({
          ...overrides,
          expiresAt: new Date('2026-11-01T09:00:00.000Z'),
        });
        expect(await world.vouchers.applySweepAction(voucher, 'expire', world.now())).toBe(true);
        expect(world.ledger.reverseCalls).toHaveLength(0);
      });
    });

    it('findSweepCandidates returns lapsed and expired live vouchers only', async () => {
      const lapsed = world.seedVoucher({
        status: 'active',
        activationExpiresAt: new Date('2026-11-01T09:59:00.000Z'),
      });
      const expired = world.seedVoucher({ expiresAt: new Date('2026-11-01T09:00:00.000Z') });
      world.seedVoucher({
        status: 'active',
        activationExpiresAt: new Date('2026-11-01T10:01:00.000Z'),
      });
      world.seedVoucher({ status: 'redeemed', expiresAt: new Date('2026-11-01T09:00:00.000Z') });
      world.seedVoucher();
      const ids = (await world.vouchers.findSweepCandidates(world.now(), 10)).map((row) => row.id);
      expect(ids.sort()).toEqual([lapsed.id, expired.id].sort());
    });
  });

  describe('system cancellations', () => {
    it('cancelBySystem reports missing, skipped and cancelled', async () => {
      const live = world.seedVoucher({ kind: 'ticket', sourceType: 'event' });
      const used = world.seedVoucher({ status: 'redeemed' });
      expect(await world.vouchers.cancelBySystem(uuidv7(), 'x', false)).toBe('missing');
      expect(await world.vouchers.cancelBySystem(used.id, 'x', false)).toBe('skipped');
      expect(
        await world.vouchers.cancelBySystem(live.id, 'Event registration cancelled', false),
      ).toBe('cancelled');
      expect(await world.vouchers.cancelBySystem(live.id, 'again', false)).toBe('skipped');
      expect(world.outbox.ofType('voucher.cancelled')).toHaveLength(1);
    });

    it('cancelLiveVouchers cancels every live voucher of the filter', async () => {
      world.seedVoucher({ userId: USER });
      world.seedVoucher({
        userId: USER,
        status: 'active',
        code: 'AAAAAA',
        activationExpiresAt: new Date('2026-11-01T10:01:00.000Z'),
      });
      world.seedVoucher({ userId: USER, status: 'redeemed' });
      world.seedVoucher({ userId: 'user-2' });
      expect(
        await world.vouchers.cancelLiveVouchers({ userId: USER }, 'Account deleted', false),
      ).toBe(2);
      expect(world.repo.vouchers.filter((row) => row.status === 'cancelled')).toHaveLength(2);
      expect(world.repo.vouchers.find((row) => row.userId === 'user-2')?.status).toBe('issued');
    });

    it('cancelLiveVouchers can target the tickets of one event through meta.eventId', async () => {
      world.seedVoucher({ kind: 'ticket', sourceType: 'event', meta: { eventId: 'event-1' } });
      world.seedVoucher({ kind: 'ticket', sourceType: 'event', meta: { eventId: 'event-2' } });
      expect(
        await world.vouchers.cancelLiveVouchers(
          { kind: 'ticket', metaEventId: 'event-1' },
          'Event cancelled',
          false,
        ),
      ).toBe(1);
    });
  });

  describe('back office reads', () => {
    it('listForAdmin filters across members', async () => {
      world.seedVoucher({ userId: USER, kind: 'coupon', tenantId: 't-1', sourceType: 'promo' });
      world.seedVoucher({
        userId: 'user-2',
        kind: 'reward',
        tenantId: 't-2',
        sourceType: 'redemption',
      });
      world.seedVoucher({ userId: 'user-2', kind: 'ticket', sourceType: 'event' });
      expect((await world.vouchers.listForAdmin({ limit: 10 })).items).toHaveLength(3);
      expect(
        (await world.vouchers.listForAdmin({ limit: 10, userId: 'user-2' })).items,
      ).toHaveLength(2);
      expect((await world.vouchers.listForAdmin({ limit: 10, kind: 'coupon' })).items).toHaveLength(
        1,
      );
      expect(
        (await world.vouchers.listForAdmin({ limit: 10, tenantId: 't-2' })).items,
      ).toHaveLength(1);
      expect(
        (await world.vouchers.listForAdmin({ limit: 10, sourceType: 'event' })).items,
      ).toHaveLength(1);
    });

    it('getById throws PC_VOUCHER_NOT_FOUND for unknown ids', async () => {
      await expect(world.vouchers.getById(uuidv7())).rejects.toMatchObject({
        code: 'PC_VOUCHER_NOT_FOUND',
      });
    });
  });
});
