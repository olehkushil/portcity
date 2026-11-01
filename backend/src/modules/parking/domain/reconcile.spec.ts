import { DEFAULT_PARKING_TARIFF } from '../../../common/contracts/parking';
import { planSession, type SessionFactsInput, type SessionStateView } from './reconcile';
import { CLOSE_REASONS } from './session-state';
import { HOUR_MS, MINUTE_MS } from './tariff';

const ENTERED = new Date('2026-01-15T12:12:00.000Z');
const at = (offsetMs: number): Date => new Date(ENTERED.getTime() + offsetMs);

const facts = (overrides: Partial<SessionFactsInput> = {}): SessionFactsInput => ({
  enteredAt: ENTERED,
  exitedAt: null,
  paidUntil: null,
  closedReason: null,
  amountPaidKopecks: 0,
  ...overrides,
});

const view = (overrides: Partial<SessionStateView> = {}): SessionStateView => ({
  status: 'open',
  paidUntil: null,
  exitedAt: null,
  amountDueKopecks: 0,
  amountPaidKopecks: 0,
  closedReason: null,
  ...overrides,
});

describe('planSession', () => {
  it('a new session inside the free window emits only opened', () => {
    const plan = planSession(null, facts(), at(10 * MINUTE_MS), DEFAULT_PARKING_TARIFF);
    expect(plan.status).toBe('open');
    expect(plan.events).toEqual(['opened']);
    expect(plan.changed).toBe(true);
    expect(plan.amountDueKopecks).toBe(0);
  });

  it('a new session first seen after the free window emits opened and payable', () => {
    const plan = planSession(null, facts(), at(68 * MINUTE_MS), DEFAULT_PARKING_TARIFF);
    expect(plan.status).toBe('payable');
    expect(plan.events).toEqual(['opened', 'payable']);
    expect(plan.amountDueKopecks).toBe(6000);
  });

  it('is idempotent: the same facts and time change nothing', () => {
    const first = planSession(null, facts(), at(68 * MINUTE_MS), DEFAULT_PARKING_TARIFF);
    const stored = view({ status: first.status, amountDueKopecks: first.amountDueKopecks });
    const second = planSession(stored, facts(), at(68 * MINUTE_MS), DEFAULT_PARKING_TARIFF);
    expect(second.changed).toBe(false);
    expect(second.events).toEqual([]);
  });

  it('open -> payable when the free window ends', () => {
    const plan = planSession(view(), facts(), at(31 * MINUTE_MS), DEFAULT_PARKING_TARIFF);
    expect(plan.status).toBe('payable');
    expect(plan.events).toEqual(['payable']);
    expect(plan.changed).toBe(true);
  });

  it('a growing amount in the same status changes the row but emits no event', () => {
    const stored = view({ status: 'payable', amountDueKopecks: 2000 });
    const plan = planSession(stored, facts(), at(61 * MINUTE_MS), DEFAULT_PARKING_TARIFF);
    expect(plan.status).toBe('payable');
    expect(plan.amountDueKopecks).toBe(6000);
    expect(plan.events).toEqual([]);
    expect(plan.changed).toBe(true);
  });

  it('payable -> paid when a payment registers paidUntil', () => {
    const stored = view({ status: 'payable', amountDueKopecks: 6000 });
    const plan = planSession(
      stored,
      facts({ paidUntil: at(2 * HOUR_MS), amountPaidKopecks: 6000 }),
      at(70 * MINUTE_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.status).toBe('paid');
    expect(plan.events).toEqual(['paid']);
    expect(plan.amountDueKopecks).toBe(0);
    expect(plan.amountPaidKopecks).toBe(6000);
    expect(plan.paidUntil?.toISOString()).toBe(at(2 * HOUR_MS).toISOString());
  });

  it('paid -> overstay after paidUntil, with the new amount', () => {
    const stored = view({ status: 'paid', paidUntil: at(2 * HOUR_MS), amountPaidKopecks: 6000 });
    const plan = planSession(
      stored,
      facts({ paidUntil: at(2 * HOUR_MS), amountPaidKopecks: 6000 }),
      at(2 * HOUR_MS + 10 * MINUTE_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.status).toBe('overstay');
    expect(plan.events).toEqual(['overstay']);
    expect(plan.amountDueKopecks).toBe(4000);
  });

  it('overstay -> paid again extends paidUntil and emits paid', () => {
    const stored = view({
      status: 'overstay',
      paidUntil: at(2 * HOUR_MS),
      amountPaidKopecks: 6000,
      amountDueKopecks: 4000,
    });
    const plan = planSession(
      stored,
      facts({ paidUntil: at(3 * HOUR_MS), amountPaidKopecks: 10_000 }),
      at(2 * HOUR_MS + 20 * MINUTE_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.status).toBe('paid');
    expect(plan.events).toEqual(['paid']);
    expect(plan.amountDueKopecks).toBe(0);
  });

  it('paid -> paid with a later paidUntil (extension before overstay) emits paid', () => {
    const stored = view({ status: 'paid', paidUntil: at(2 * HOUR_MS), amountPaidKopecks: 6000 });
    const plan = planSession(
      stored,
      facts({ paidUntil: at(3 * HOUR_MS), amountPaidKopecks: 10_000 }),
      at(110 * MINUTE_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.status).toBe('paid');
    expect(plan.events).toEqual(['paid']);
  });

  it('exit after paying closes the session with reason exit', () => {
    const stored = view({ status: 'paid', paidUntil: at(2 * HOUR_MS), amountPaidKopecks: 6000 });
    const plan = planSession(
      stored,
      facts({ paidUntil: at(2 * HOUR_MS), amountPaidKopecks: 6000, exitedAt: at(100 * MINUTE_MS) }),
      at(3 * HOUR_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.status).toBe('closed');
    expect(plan.closedReason).toBe(CLOSE_REASONS.exit);
    expect(plan.events).toEqual(['closed']);
    expect(plan.amountDueKopecks).toBe(0);
  });

  it('exit with an unpaid amount closes as closed_unpaid and keeps the amount', () => {
    const stored = view({ status: 'payable', amountDueKopecks: 2000 });
    const plan = planSession(
      stored,
      facts({ exitedAt: at(50 * MINUTE_MS) }),
      at(3 * HOUR_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.status).toBe('closed_unpaid');
    expect(plan.amountDueKopecks).toBe(2000);
    expect(plan.events).toEqual(['closed']);
  });

  it('an explicit free close reason wins over the amount', () => {
    const stored = view({ status: 'payable', amountDueKopecks: 6000 });
    const plan = planSession(
      stored,
      facts({ exitedAt: at(70 * MINUTE_MS), closedReason: CLOSE_REASONS.airRaid }),
      at(3 * HOUR_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.status).toBe('closed_free');
    expect(plan.closedReason).toBe(CLOSE_REASONS.airRaid);
    expect(plan.amountDueKopecks).toBe(0);
  });

  it('a closed session stays unchanged on a replay of the same facts', () => {
    const stored = view({
      status: 'closed',
      exitedAt: at(100 * MINUTE_MS),
      paidUntil: at(2 * HOUR_MS),
      amountPaidKopecks: 6000,
      closedReason: CLOSE_REASONS.exit,
    });
    const plan = planSession(
      stored,
      facts({ paidUntil: at(2 * HOUR_MS), amountPaidKopecks: 6000, exitedAt: at(100 * MINUTE_MS) }),
      at(5 * HOUR_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.changed).toBe(false);
    expect(plan.events).toEqual([]);
  });

  it('keeps a stored close reason when the provider does not send one', () => {
    const stored = view({
      status: 'closed',
      exitedAt: at(20 * MINUTE_MS),
      closedReason: CLOSE_REASONS.userLeft,
    });
    const plan = planSession(
      stored,
      facts({ exitedAt: at(20 * MINUTE_MS) }),
      at(HOUR_MS),
      DEFAULT_PARKING_TARIFF,
    );
    expect(plan.closedReason).toBe(CLOSE_REASONS.userLeft);
    expect(plan.changed).toBe(false);
  });
});
