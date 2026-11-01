import {
  PROMOS_JOBS,
  type PromosEventsDeps,
  handlePromosEventsJob,
} from './promos-events.handlers';

const NOW = new Date('2026-11-01T12:00:00.000Z');

function deps(overrides: Partial<PromosEventsDeps> = {}): PromosEventsDeps {
  return {
    now: () => NOW,
    markRegistrationUsed: jest.fn(async () => 'used' as const),
    cancelRegistrationByVoucher: jest.fn(async () => 'cancelled' as const),
    cancelCouponClaim: jest.fn(async () => 'coupon_released' as const),
    finishDueEvents: jest.fn(async () => 2),
    ...overrides,
  };
}

function outboxJob(payload: Record<string, unknown>): Record<string, unknown> {
  return { eventId: 'evt-1', type: 'x', aggregateType: 'voucher', aggregateId: 'v', payload };
}

describe('handlePromosEventsJob', () => {
  it('marks the registration used when a ticket voucher is redeemed', async () => {
    const d = deps();
    const outcome = await handlePromosEventsJob(
      'voucher.redeemed',
      outboxJob({ voucherId: 'voucher-1', kind: 'ticket', sourceType: 'event' }),
      d,
    );
    expect(d.markRegistrationUsed).toHaveBeenCalledWith('voucher-1');
    expect(outcome).toEqual({
      job: 'voucher.redeemed',
      action: 'used',
      details: { voucherId: 'voucher-1' },
    });
  });

  it('ignores redeemed vouchers that are not event tickets', async () => {
    const d = deps();
    const outcome = await handlePromosEventsJob(
      'voucher.redeemed',
      outboxJob({ voucherId: 'voucher-1', kind: 'coupon', sourceType: 'promo' }),
      d,
    );
    expect(outcome.action).toBe('ignored');
    expect(d.markRegistrationUsed).not.toHaveBeenCalled();
  });

  it('cancels the registration when its ticket is cancelled on the rewards side', async () => {
    const d = deps();
    const outcome = await handlePromosEventsJob(
      'voucher.cancelled',
      outboxJob({ voucherId: 'voucher-1', kind: 'ticket', sourceType: 'event', reason: 'expired' }),
      d,
    );
    expect(d.cancelRegistrationByVoucher).toHaveBeenCalledWith(
      'voucher-1',
      'Ticket cancelled: expired',
    );
    expect(outcome.action).toBe('cancelled');
  });

  it('cancels the coupon claim named by the voucher source id', async () => {
    const d = deps();
    const outcome = await handlePromosEventsJob(
      'voucher.cancelled',
      outboxJob({
        voucherId: 'voucher-1',
        kind: 'coupon',
        sourceType: 'promo',
        sourceId: 'claim-1',
      }),
      d,
    );
    expect(d.cancelCouponClaim).toHaveBeenCalledWith('claim-1');
    expect(outcome).toEqual({
      job: 'voucher.cancelled',
      action: 'coupon_released',
      details: { voucherId: 'voucher-1', claimId: 'claim-1' },
    });
  });

  it('reports a replayed cancellation without releasing twice', async () => {
    const d = deps({ cancelCouponClaim: jest.fn(async () => 'already_cancelled' as const) });
    const outcome = await handlePromosEventsJob(
      'voucher.cancelled',
      outboxJob({
        voucherId: 'voucher-1',
        kind: 'coupon',
        sourceType: 'promo',
        sourceId: 'claim-1',
      }),
      d,
    );
    expect(outcome.action).toBe('already_cancelled');
  });

  it('ignores coupons without a claim id', async () => {
    const d = deps();
    const outcome = await handlePromosEventsJob(
      'voucher.cancelled',
      outboxJob({ voucherId: 'voucher-1', kind: 'coupon', sourceType: 'promo', sourceId: null }),
      d,
    );
    expect(outcome.action).toBe('ignored');
    expect(d.cancelCouponClaim).not.toHaveBeenCalled();
  });

  it.each([
    [
      { kind: 'reward', sourceType: 'redemption', voucherId: 'voucher-1' },
      'not a coupon or ticket',
    ],
    [{ kind: 'ticket', sourceType: 'event' }, 'missing voucherId'],
  ])('ignores cancelled voucher %j', async (payload, reason) => {
    const d = deps();
    const outcome = await handlePromosEventsJob('voucher.cancelled', outboxJob(payload), d);
    expect(outcome.action).toBe('ignored');
    expect(outcome.details).toMatchObject({ reason });
  });

  it('tolerates job data without a payload', async () => {
    const outcome = await handlePromosEventsJob('voucher.cancelled', null, deps());
    expect(outcome.action).toBe('ignored');
  });

  it('finishes due events on the hourly schedule', async () => {
    const d = deps();
    const outcome = await handlePromosEventsJob(PROMOS_JOBS.finishEvents, {}, d);
    expect(d.finishDueEvents).toHaveBeenCalledWith(NOW);
    expect(outcome).toEqual({
      job: 'promos-finish-events',
      action: 'finished',
      details: { count: 2 },
    });
  });

  it('throws on unknown job names so the queue surfaces them', async () => {
    await expect(handlePromosEventsJob('promo.published', {}, deps())).rejects.toThrow(
      'Unknown promos job "promo.published"',
    );
  });
});
