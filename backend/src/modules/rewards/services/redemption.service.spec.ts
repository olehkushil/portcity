import { uuidv7 } from 'uuidv7';
import { FAKE_TX, RewardsWorld, tenantSummary } from '../../../../test/rewards/support/fakes';
import type { ParkingSessionSummary } from '../../../common/contracts/parking';
import { rewardVoucherMeta, tenantSubtitle, toRedeemRewardResponse } from './redemption.service';

const USER = 'user-1';

function parkingSession(): ParkingSessionSummary {
  return {
    id: 'session-1',
    userId: USER,
    vehicleId: 'vehicle-1',
    plate: 'AC1234BC',
    zone: 'underground',
    enteredAt: new Date('2026-11-01T09:12:00.000Z'),
    exitedAt: null,
    status: 'payable',
    paidUntil: null,
    amountDueKopecks: 2000,
    amountPaidKopecks: 0,
    source: 'provider',
    lastSyncedAt: null,
  };
}

describe('RedemptionService.redeem', () => {
  let world: RewardsWorld;

  beforeEach(() => {
    world = new RewardsWorld();
    world.ledger.setBalance(USER, 320);
  });

  it('spends the points, issues the voucher and links both to the redemption', async () => {
    const tenant = world.content.add(tenantSummary({ name: 'Aroma Kava', floor: 1 }));
    const reward = world.seedReward({
      title: 'Кава з собою',
      costPoints: 60,
      tenantId: tenant.id,
      stock: 10,
    });

    const result = await world.redemptions.redeem(USER, reward.id);

    expect(result.pointsSpent).toBe(60);
    expect(result.availableBalance).toBe(260);
    expect(result.voucher).toMatchObject({
      userId: USER,
      kind: 'reward',
      title: 'Кава з собою',
      subtitle: 'Aroma Kava, 1 поверх',
      tenantId: tenant.id,
      status: 'issued',
      sourceType: 'redemption',
      sourceId: result.redemption.id,
      expiresAt: new Date('2026-12-01T10:00:00.000Z'),
      meta: { rewardId: reward.id, rewardKind: 'partner', costPoints: 60 },
    });
    expect(result.redemption).toMatchObject({
      userId: USER,
      rewardId: reward.id,
      status: 'issued',
      pointsTxId: result.pointsTxId,
      voucherId: result.voucher.id,
    });

    const spend = world.ledger.spendCalls[0];
    expect(spend?.input).toEqual({
      userId: USER,
      amount: 60,
      sourceType: 'redemption',
      sourceId: result.redemption.id,
      idempotencyKey: `redemption:${result.redemption.id}`,
      reason: 'Reward: Кава з собою',
      // History display data written by the ledger at posting time.
      title: 'Обмін на винагороду',
      subtitle: 'Кава з собою',
      counterparty: {
        rewardId: reward.id,
        rewardTitle: 'Кава з собою',
        tenantId: reward.tenantId,
        tenantName: 'Aroma Kava',
      },
    });
    expect(spend?.tx).toBe(FAKE_TX);
    expect(world.repo.reward(reward.id)?.stock).toBe(9);
    expect(world.prisma.transactions).toBe(1);
    expect(world.outbox.types()).toEqual(['voucher.issued', 'redemption.created']);
    expect(world.outbox.ofType('redemption.created')[0]?.payload).toEqual({
      redemptionId: result.redemption.id,
      userId: USER,
      rewardId: reward.id,
      voucherId: result.voucher.id,
      pointsTxId: result.pointsTxId,
      costPoints: 60,
    });
  });

  it('issues a certificate voucher for certificate rewards', async () => {
    const reward = world.seedReward({
      kind: 'certificate',
      title: 'Подарункова карта 200 ₴',
      costPoints: 200,
    });
    const result = await world.redemptions.redeem(USER, reward.id);
    expect(result.voucher.kind).toBe('certificate');
    expect(result.voucher.subtitle).toBeNull();
    expect(result.voucher.tenantId).toBeNull();
  });

  it('caps the voucher expiry at the reward validTo', async () => {
    const validTo = new Date('2026-11-05T00:00:00.000Z');
    const reward = world.seedReward({ validTo });
    const result = await world.redemptions.redeem(USER, reward.id);
    expect(result.voucher.expiresAt).toEqual(validTo);
  });

  it('uses REWARDS_VOUCHER_TTL_DAYS for the voucher expiry', async () => {
    world = new RewardsWorld({ config: { REWARDS_VOUCHER_TTL_DAYS: 7 } });
    world.ledger.setBalance(USER, 100);
    const reward = world.seedReward();
    const result = await world.redemptions.redeem(USER, reward.id);
    expect(result.voucher.expiresAt).toEqual(new Date('2026-11-08T10:00:00.000Z'));
  });

  it('attaches the current parking session to a parking_hour voucher', async () => {
    world.parking.session = parkingSession();
    const reward = world.seedReward({
      kind: 'parking_hour',
      title: 'Година паркінгу',
      costPoints: 40,
    });
    const result = await world.redemptions.redeem(USER, reward.id);
    expect(result.voucher.meta).toEqual({
      rewardId: reward.id,
      rewardKind: 'parking_hour',
      costPoints: 40,
      parkingHours: 1,
      parkingSessionId: 'session-1',
      parkingPlate: 'AC1234BC',
      parkingZone: 'underground',
    });
  });

  it('never blocks on enrichment ports (content and parking stubs)', async () => {
    world.content.fail = true;
    world.parking.fail = true;
    const reward = world.seedReward({ kind: 'parking_hour', tenantId: uuidv7(), costPoints: 40 });
    const result = await world.redemptions.redeem(USER, reward.id);
    expect(result.voucher.subtitle).toBeNull();
    expect(result.voucher.meta).toEqual({
      rewardId: reward.id,
      rewardKind: 'parking_hour',
      costPoints: 40,
      parkingHours: 1,
    });
  });

  it('reports a null balance when the ledger cannot answer after the spend', async () => {
    const reward = world.seedReward();
    world.ledger.failGetBalance = true;
    const result = await world.redemptions.redeem(USER, reward.id);
    expect(result.availableBalance).toBeNull();
    expect(world.ledger.balanceOf(USER)).toBe(260);
  });

  it('rolls back the redemption, the stock and the events when points are insufficient', async () => {
    world.ledger.setBalance(USER, 59);
    const reward = world.seedReward({ costPoints: 60, stock: 3 });
    await expect(world.redemptions.redeem(USER, reward.id)).rejects.toMatchObject({
      code: 'PC_POINTS_INSUFFICIENT',
      status: 422,
    });
    expect(world.repo.redemptions).toEqual([]);
    expect(world.repo.vouchers).toEqual([]);
    expect(world.repo.reward(reward.id)?.stock).toBe(3);
    expect(world.outbox.events).toEqual([]);
    expect(world.ledger.balanceOf(USER)).toBe(59);
    expect(world.prisma.rollbacks).toBe(1);
  });

  it('rolls back the spend when issuing the voucher fails', async () => {
    const reward = world.seedReward({ stock: 2 });
    jest.spyOn(world.repo, 'createVoucher').mockRejectedValueOnce(new Error('insert failed'));
    await expect(world.redemptions.redeem(USER, reward.id)).rejects.toThrow('insert failed');
    expect(world.ledger.balanceOf(USER)).toBe(320);
    expect(world.repo.reward(reward.id)?.stock).toBe(2);
    expect(world.repo.redemptions).toEqual([]);
  });

  it.each([
    ['inactive', { active: false }, 'PC_REWARD_INACTIVE', 'inactive'],
    [
      'not started',
      { validFrom: new Date('2026-11-02T00:00:00.000Z') },
      'PC_REWARD_INACTIVE',
      'not_started',
    ],
    ['ended', { validTo: new Date('2026-10-31T00:00:00.000Z') }, 'PC_REWARD_INACTIVE', 'ended'],
    ['out of stock', { stock: 0 }, 'PC_REWARD_OUT_OF_STOCK', 'out_of_stock'],
  ])('rejects a reward that is %s', async (_name, overrides, code, reason) => {
    const reward = world.seedReward(overrides);
    await expect(world.redemptions.redeem(USER, reward.id)).rejects.toMatchObject({
      code,
      details: { reason },
    });
    expect(world.ledger.spendCalls).toHaveLength(0);
  });

  it('enforces the per-user limit over non-cancelled redemptions', async () => {
    const reward = world.seedReward({ perUserLimit: 2, costPoints: 10 });
    await world.redemptions.redeem(USER, reward.id);
    const second = await world.redemptions.redeem(USER, reward.id);
    await expect(world.redemptions.redeem(USER, reward.id)).rejects.toMatchObject({
      code: 'PC_REWARD_LIMIT_REACHED',
    });
    await world.vouchers.cancelForMember(USER, second.voucher.id);
    await expect(world.redemptions.redeem(USER, reward.id)).resolves.toMatchObject({
      pointsSpent: 10,
    });
    world.ledger.setBalance('user-2', 100);
    await expect(world.redemptions.redeem('user-2', reward.id)).resolves.toMatchObject({
      pointsSpent: 10,
    });
  });

  it('runs out of stock exactly at zero', async () => {
    const reward = world.seedReward({ stock: 1, costPoints: 10 });
    await world.redemptions.redeem(USER, reward.id);
    await expect(world.redemptions.redeem(USER, reward.id)).rejects.toMatchObject({
      code: 'PC_REWARD_OUT_OF_STOCK',
    });
  });

  it('rejects an unknown reward', async () => {
    await expect(world.redemptions.redeem(USER, uuidv7())).rejects.toMatchObject({
      code: 'PC_REWARD_NOT_FOUND',
      status: 404,
    });
  });
});

describe('redemption helpers', () => {
  it.each([
    [null, null],
    [tenantSummary({ name: 'Aroma Kava', floor: 1 }), 'Aroma Kava, 1 поверх'],
    [tenantSummary({ name: 'Premier City', floor: 3 }), 'Premier City, 3 поверх'],
    [tenantSummary({ name: 'Інфостійка', floor: null }), 'Інфостійка'],
  ])('tenantSubtitle(%j) = %p', (tenant, expected) => {
    expect(tenantSubtitle(tenant)).toBe(expected);
  });

  it('rewardVoucherMeta adds parking data only for parking_hour rewards', () => {
    const session = parkingSession();
    expect(rewardVoucherMeta({ id: 'r1', kind: 'gift', costPoints: 5 }, session)).toEqual({
      rewardId: 'r1',
      rewardKind: 'gift',
      costPoints: 5,
    });
    expect(rewardVoucherMeta({ id: 'r2', kind: 'parking_hour', costPoints: 40 }, null)).toEqual({
      rewardId: 'r2',
      rewardKind: 'parking_hour',
      costPoints: 40,
      parkingHours: 1,
    });
  });

  it('toRedeemRewardResponse projects the redemption for HTTP', async () => {
    const world = new RewardsWorld();
    world.ledger.setBalance(USER, 100);
    const reward = world.seedReward({ costPoints: 60 });
    const result = await world.redemptions.redeem(USER, reward.id);
    expect(toRedeemRewardResponse(result)).toEqual({
      redemption: {
        id: result.redemption.id,
        rewardId: reward.id,
        status: 'issued',
        createdAt: world.now(),
      },
      voucher: result.voucher,
      pointsSpent: 60,
      pointsTxId: result.pointsTxId,
      availableBalance: 40,
    });
  });
});
