import { uuidv7 } from 'uuidv7';
import { FAKE_TX, RewardsWorld } from '../../../../test/rewards/support/fakes';
import type { AdminVoucherContext } from './admin-vouchers.service';

const ADMIN: AdminVoucherContext = { actor: { type: 'admin', id: 'admin-1' }, ip: '10.0.0.1' };

describe('AdminVouchersService', () => {
  let world: RewardsWorld;

  beforeEach(() => {
    world = new RewardsWorld();
  });

  it('issues a goodwill voucher with sourceType admin and audits it in one transaction', async () => {
    const voucher = await world.adminVouchers.issue(
      {
        userId: 'user-1',
        kind: 'certificate',
        title: 'Подарункова карта 200 ₴',
        subtitle: 'Інфостійка',
        expiresAt: new Date('2026-12-31T21:59:59.000Z'),
        meta: { amountKopecks: 20_000 },
        reason: 'complaint #42',
      },
      ADMIN,
    );
    expect(voucher).toMatchObject({
      userId: 'user-1',
      kind: 'certificate',
      status: 'issued',
      sourceType: 'admin',
      subtitle: 'Інфостійка',
      tenantId: null,
      meta: { amountKopecks: 20_000, issuedByAdminId: 'admin-1', issueReason: 'complaint #42' },
    });
    expect(voucher.sourceId).toEqual(expect.any(String));
    expect(world.prisma.transactions).toBe(1);
    expect(world.audit.entries[0]?.tx).toBe(FAKE_TX);
    expect(world.audit.entries[0]?.entry).toMatchObject({
      action: 'voucher.issue',
      entityType: 'voucher',
      entityId: voucher.id,
      reason: 'complaint #42',
      ip: '10.0.0.1',
    });
    expect(world.outbox.types()).toEqual(['voucher.issued']);
  });

  it('treats every call as a new admin action', async () => {
    const input = { userId: 'user-1', kind: 'reward' as const, title: 'Кава з собою' };
    const first = await world.adminVouchers.issue(input, ADMIN);
    const second = await world.adminVouchers.issue(input, ADMIN);
    expect(first.id).not.toBe(second.id);
    expect(first.meta).toEqual({ issuedByAdminId: 'admin-1' });
    expect(first.expiresAt).toBeNull();
  });

  it('cancels with the points rule and audits the decision', async () => {
    world.ledger.setBalance('user-1', 100);
    const reward = world.seedReward({ costPoints: 60 });
    const { voucher } = await world.redemptions.redeem('user-1', reward.id);

    const cancelled = await world.adminVouchers.cancel(voucher.id, { reason: 'goodwill' }, ADMIN);
    expect(cancelled.status).toBe('cancelled');
    expect(world.ledger.balanceOf('user-1')).toBe(100);
    expect(world.audit.entries.at(-1)?.entry).toMatchObject({
      action: 'voucher.cancel',
      entityId: voucher.id,
      after: { status: 'cancelled', refundPoints: true },
      reason: 'goodwill',
    });
  });

  it('cancels without refund when asked', async () => {
    world.ledger.setBalance('user-1', 100);
    const reward = world.seedReward({ costPoints: 60 });
    const { voucher } = await world.redemptions.redeem('user-1', reward.id);
    await world.adminVouchers.cancel(voucher.id, { reason: 'abuse', refundPoints: false }, ADMIN);
    expect(world.ledger.balanceOf('user-1')).toBe(40);
    expect(world.audit.entries.at(-1)?.entry.after).toEqual({
      status: 'cancelled',
      refundPoints: false,
    });
  });

  it('does not audit a failed cancellation', async () => {
    const voucher = world.seedVoucher({ status: 'redeemed' });
    await expect(
      world.adminVouchers.cancel(voucher.id, { reason: 'x' }, ADMIN),
    ).rejects.toMatchObject({
      code: 'PC_VOUCHER_ALREADY_REDEEMED',
    });
    expect(world.audit.entries).toEqual([]);
  });

  it('delegates list and get to the voucher service', async () => {
    const voucher = world.seedVoucher({ userId: 'user-9' });
    expect(
      (await world.adminVouchers.list({ limit: 10, userId: 'user-9' })).items.map((v) => v.id),
    ).toEqual([voucher.id]);
    expect((await world.adminVouchers.get(voucher.id)).id).toBe(voucher.id);
    await expect(world.adminVouchers.get(uuidv7())).rejects.toMatchObject({
      code: 'PC_VOUCHER_NOT_FOUND',
    });
  });
});
