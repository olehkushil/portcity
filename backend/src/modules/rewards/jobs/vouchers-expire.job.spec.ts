import { RewardsWorld } from '../../../../test/rewards/support/fakes';
import {
  type SweepCandidate,
  type VouchersExpireDeps,
  runVouchersExpire,
} from './vouchers-expire.job';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

function candidate(id: string, overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return { id, status: 'active', activationExpiresAt: at(-10), expiresAt: null, ...overrides };
}

/** Minimal store: apply() removes the row so the next batch does not see it again. */
function deps(
  rows: SweepCandidate[],
  overrides: Partial<VouchersExpireDeps<SweepCandidate>> = {},
): VouchersExpireDeps<SweepCandidate> & { applied: Array<[string, string]>; logs: string[] } {
  const pending = [...rows];
  const applied: Array<[string, string]> = [];
  const logs: string[] = [];
  return {
    applied,
    logs,
    now: () => NOW,
    batchSize: 2,
    findCandidates: async (_now, limit) => pending.slice(0, limit),
    apply: async (voucher, action) => {
      applied.push([voucher.id, action]);
      pending.splice(
        pending.findIndex((row) => row.id === voucher.id),
        1,
      );
      return true;
    },
    log: (message) => logs.push(message),
    ...overrides,
  };
}

describe('runVouchersExpire (handler logic)', () => {
  it('returns lapsed activations to issued and expires vouchers past expiresAt', async () => {
    const d = deps([
      candidate('lapsed'),
      candidate('expired', { status: 'issued', activationExpiresAt: null, expiresAt: at(-1) }),
      candidate('both', { activationExpiresAt: at(-30), expiresAt: at(-5) }),
    ]);
    const summary = await runVouchersExpire(d);
    expect(d.applied).toEqual([
      ['lapsed', 'deactivate'],
      ['expired', 'expire'],
      ['both', 'expire'],
    ]);
    expect(summary).toEqual({
      batches: 2,
      scanned: 3,
      expired: 2,
      deactivated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(d.logs).toEqual([expect.stringContaining('expired 2, deactivated 1')]);
  });

  it('uses one snapshot time for the whole run', async () => {
    const seen: Date[] = [];
    let calls = 0;
    const d = deps([candidate('a'), candidate('b'), candidate('c')], {
      now: () => new Date(NOW.getTime() + 1000 * calls++),
    });
    const findCandidates = d.findCandidates;
    d.findCandidates = async (now, limit) => {
      seen.push(now);
      return findCandidates(now, limit);
    };
    await runVouchersExpire(d);
    expect(new Set(seen.map((date) => date.getTime())).size).toBe(1);
  });

  it('counts rows changed concurrently as skipped and stops without progress', async () => {
    const d = deps([candidate('a'), candidate('b')], { apply: async () => false });
    const findCandidates = jest.fn(d.findCandidates);
    d.findCandidates = findCandidates;
    const summary = await runVouchersExpire(d);
    expect(summary).toMatchObject({
      batches: 1,
      scanned: 2,
      skipped: 2,
      expired: 0,
      deactivated: 0,
    });
    expect(findCandidates).toHaveBeenCalledTimes(1);
    expect(d.logs).toEqual([]);
  });

  it('keeps going when one voucher fails and reports it', async () => {
    const d = deps([candidate('bad'), candidate('good')]);
    const apply = d.apply;
    d.apply = async (voucher, action, now) => {
      if (voucher.id === 'bad') {
        throw new Error('deadlock');
      }
      return apply(voucher, action, now);
    };
    const summary = await runVouchersExpire(d);
    expect(summary).toMatchObject({ failed: 1, deactivated: 1 });
    expect(d.logs[0]).toContain('voucher bad (deactivate) failed: deadlock');
  });

  it('skips candidates that need nothing (defensive)', async () => {
    const d = deps([candidate('fresh', { activationExpiresAt: at(60) })], { batchSize: 5 });
    const summary = await runVouchersExpire(d);
    expect(summary).toMatchObject({ scanned: 1, skipped: 1 });
    expect(d.applied).toEqual([]);
  });

  it('never processes the same voucher twice in one run', async () => {
    const rows = [candidate('a'), candidate('b')];
    const d = deps(rows, {
      findCandidates: async () => rows,
      apply: jest.fn(async () => true),
    });
    const summary = await runVouchersExpire(d);
    expect(d.apply).toHaveBeenCalledTimes(2);
    expect(summary.batches).toBe(2);
  });

  it('respects maxBatches', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => candidate(`v${index}`));
    const d = deps(rows, { maxBatches: 2 });
    const summary = await runVouchersExpire(d);
    expect(summary).toMatchObject({ batches: 2, deactivated: 4 });
  });

  it('does nothing on an empty queue', async () => {
    const d = deps([]);
    expect(await runVouchersExpire(d)).toEqual({
      batches: 1,
      scanned: 0,
      expired: 0,
      deactivated: 0,
      skipped: 0,
      failed: 0,
    });
  });
});

describe('runVouchersExpire with VoucherService (sweep end to end on fakes)', () => {
  it('applies the voucher state machine to stored rows', async () => {
    const world = new RewardsWorld({ now: NOW.toISOString() });
    const lapsed = world.seedVoucher({
      status: 'active',
      code: 'AAAAAA',
      tokenHash: 'h',
      activatedAt: at(-150),
      activationExpiresAt: at(-30),
      expiresAt: at(86_400),
    });
    const expiredIssued = world.seedVoucher({ status: 'issued', expiresAt: at(-60) });
    const expiredActive = world.seedVoucher({
      status: 'active',
      code: 'BBBBBB',
      activationExpiresAt: at(60),
      expiresAt: at(-1),
    });
    const live = world.seedVoucher({
      status: 'active',
      code: 'CCCCCC',
      activationExpiresAt: at(60),
    });
    const plain = world.seedVoucher({ status: 'issued' });
    const redeemed = world.seedVoucher({ status: 'redeemed', expiresAt: at(-60) });

    const summary = await runVouchersExpire({
      now: () => world.now(),
      batchSize: world.config.REWARDS_SWEEP_BATCH_SIZE,
      findCandidates: (now, limit) => world.vouchers.findSweepCandidates(now, limit),
      apply: (voucher, action, now) => world.vouchers.applySweepAction(voucher, action, now),
    });

    expect(summary).toMatchObject({ expired: 2, deactivated: 1, failed: 0 });
    expect(world.repo.voucher(lapsed.id)).toMatchObject({
      status: 'issued',
      code: null,
      activationExpiresAt: null,
    });
    expect(world.repo.voucher(expiredIssued.id)?.status).toBe('expired');
    expect(world.repo.voucher(expiredActive.id)).toMatchObject({ status: 'expired', code: null });
    expect(world.repo.voucher(live.id)).toMatchObject({ status: 'active', code: 'CCCCCC' });
    expect(world.repo.voucher(plain.id)?.status).toBe('issued');
    expect(world.repo.voucher(redeemed.id)?.status).toBe('redeemed');
    expect(
      world.outbox
        .ofType('voucher.expired')
        .map((event) => event.aggregateId)
        .sort(),
    ).toEqual([expiredIssued.id, expiredActive.id].sort());

    // The freed code can be handed out again and the lapsed voucher re-activated.
    const again = await world.vouchers.activate(lapsed.userId, lapsed.id);
    expect(again.voucher.status).toBe('active');
  });
});
