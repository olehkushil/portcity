import { IDENTITY_EVENTS, PROMO_EVENTS } from '../../../common/contracts/events';
import { QUEUES } from '../../../common/queue/queue.constants';
import { RewardsWorld } from '../../../../test/rewards/support/fakes';
import {
  REWARDS_HANDLED_EVENTS,
  REWARDS_OUTBOX_ROUTES,
  type RewardsEventsDeps,
  handleRewardsEventJob,
} from './rewards-events.handler';

function fakeDeps(): RewardsEventsDeps & {
  cancelVoucher: jest.Mock;
  cancelLiveVouchers: jest.Mock;
} {
  return {
    cancelVoucher: jest.fn(async () => 'cancelled' as const),
    cancelLiveVouchers: jest.fn(async () => 3),
    log: jest.fn(),
  };
}

function job(type: string, payload: Record<string, unknown>) {
  return {
    eventId: 'evt-1',
    type,
    aggregateType: 'x',
    aggregateId: 'y',
    payload,
    occurredAt: '2026-11-01T10:00:00.000Z',
  };
}

describe('handleRewardsEventJob', () => {
  it('cancels the ticket of a cancelled registration without refund', async () => {
    const deps = fakeDeps();
    const outcome = await handleRewardsEventJob(
      PROMO_EVENTS.eventRegistrationCancelled,
      job(PROMO_EVENTS.eventRegistrationCancelled, {
        eventId: 'e',
        registrationId: 'r',
        userId: 'u',
        voucherId: 'v-1',
      }),
      deps,
    );
    expect(deps.cancelVoucher).toHaveBeenCalledWith('v-1', 'Event registration cancelled', false);
    expect(outcome).toEqual({
      type: 'event.registration_cancelled',
      action: 'cancelled',
      cancelled: 1,
    });
  });

  it.each(['skipped', 'missing'] as const)(
    'reports %s tickets without counting them',
    async (result) => {
      const deps = fakeDeps();
      deps.cancelVoucher.mockResolvedValueOnce(result);
      const outcome = await handleRewardsEventJob(
        PROMO_EVENTS.eventRegistrationCancelled,
        job(PROMO_EVENTS.eventRegistrationCancelled, { voucherId: 'v-1' }),
        deps,
      );
      expect(outcome).toMatchObject({ action: result, cancelled: 0 });
    },
  );

  it('ignores a registration without ticket', async () => {
    const deps = fakeDeps();
    const outcome = await handleRewardsEventJob(
      PROMO_EVENTS.eventRegistrationCancelled,
      job(PROMO_EVENTS.eventRegistrationCancelled, { voucherId: null }),
      deps,
    );
    expect(outcome.action).toBe('ignored');
    expect(deps.cancelVoucher).not.toHaveBeenCalled();
  });

  it('cancels every live voucher of a deleted account', async () => {
    const deps = fakeDeps();
    const outcome = await handleRewardsEventJob(
      IDENTITY_EVENTS.deleted,
      job(IDENTITY_EVENTS.deleted, {
        userId: 'u-1',
        requestId: 'r',
        deletedAt: '2026-11-01T00:00:00.000Z',
      }),
      deps,
    );
    expect(deps.cancelLiveVouchers).toHaveBeenCalledWith(
      { userId: 'u-1' },
      'Account deleted',
      false,
    );
    expect(outcome).toEqual({ type: 'user.deleted', action: 'cancelled', cancelled: 3 });
    deps.cancelLiveVouchers.mockResolvedValueOnce(0);
    expect(
      (await handleRewardsEventJob(IDENTITY_EVENTS.deleted, { userId: 'u-1' }, deps)).action,
    ).toBe('skipped');
  });

  it('ignores a deleted-account event without user id', async () => {
    const deps = fakeDeps();
    expect(
      (await handleRewardsEventJob(IDENTITY_EVENTS.deleted, job(IDENTITY_EVENTS.deleted, {}), deps))
        .action,
    ).toBe('ignored');
    expect(deps.cancelLiveVouchers).not.toHaveBeenCalled();
  });

  it('ignores unknown job names and malformed data', async () => {
    const deps = fakeDeps();
    expect(
      await handleRewardsEventJob('receipt.credited', job('receipt.credited', {}), deps),
    ).toEqual({
      type: 'receipt.credited',
      action: 'ignored',
      cancelled: 0,
    });
    expect(
      (await handleRewardsEventJob(PROMO_EVENTS.eventRegistrationCancelled, 'garbage', deps))
        .action,
    ).toBe('ignored');
  });

  it('routes every handled event to the rewards-events queue', () => {
    expect(Object.keys(REWARDS_OUTBOX_ROUTES).sort()).toEqual([...REWARDS_HANDLED_EVENTS].sort());
    expect(new Set(Object.values(REWARDS_OUTBOX_ROUTES))).toEqual(new Set([QUEUES.rewardsEvents]));
  });

  it('is idempotent end to end with VoucherService (redelivered event)', async () => {
    const world = new RewardsWorld();
    const ticket = world.seedVoucher({ kind: 'ticket', sourceType: 'event' });
    const deps: RewardsEventsDeps = {
      cancelVoucher: (id, reason, refund) => world.vouchers.cancelBySystem(id, reason, refund),
      cancelLiveVouchers: (filter, reason, refund) =>
        world.vouchers.cancelLiveVouchers(filter, reason, refund),
    };
    const data = job(PROMO_EVENTS.eventRegistrationCancelled, { voucherId: ticket.id });
    expect(
      (await handleRewardsEventJob(PROMO_EVENTS.eventRegistrationCancelled, data, deps)).action,
    ).toBe('cancelled');
    expect(
      (await handleRewardsEventJob(PROMO_EVENTS.eventRegistrationCancelled, data, deps)).action,
    ).toBe('skipped');
    expect(world.outbox.ofType('voucher.cancelled')).toHaveLength(1);
  });
});
