import {
  DEFAULT_PARKING_TARIFF,
  PARKING_SESSION_STATUSES,
  type ParkingSessionStatus,
} from '../../../common/contracts/parking';
import { DomainError } from '../../../common/errors/domain-error';
import {
  CLOSE_REASONS,
  SESSION_TRANSITIONS,
  assertTransition,
  canTransition,
  deriveSessionState,
  isFinalStatus,
  isPayableStatus,
} from './session-state';
import { HOUR_MS, MINUTE_MS } from './tariff';

const ENTERED = new Date('2026-01-15T12:12:00.000Z');
const at = (offsetMs: number): Date => new Date(ENTERED.getTime() + offsetMs);

describe('session transitions', () => {
  const allowed: Array<[ParkingSessionStatus, ParkingSessionStatus]> = [
    ['open', 'payable'],
    ['open', 'paid'],
    ['open', 'closed'],
    ['open', 'closed_free'],
    ['payable', 'paid'],
    ['payable', 'closed_unpaid'],
    ['payable', 'closed_free'],
    ['paid', 'overstay'],
    ['paid', 'closed'],
    ['overstay', 'paid'],
    ['overstay', 'closed_unpaid'],
    ['paid', 'paid'],
    ['closed', 'closed'],
  ];

  it.each(allowed)('%s -> %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  const forbidden: Array<[ParkingSessionStatus, ParkingSessionStatus]> = [
    ['payable', 'open'],
    ['paid', 'payable'],
    ['paid', 'open'],
    ['overstay', 'open'],
    ['closed', 'open'],
    ['closed', 'paid'],
    ['closed_unpaid', 'closed'],
    ['closed_free', 'payable'],
    ['open', 'overstay'],
    ['payable', 'overstay'],
  ];

  it.each(forbidden)('%s -> %s is rejected with PC_PARKING_INVALID_TRANSITION', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    try {
      assertTransition(from, to);
      throw new Error('expected a DomainError');
    } catch (error) {
      expect(DomainError.is(error)).toBe(true);
      expect((error as DomainError).code).toBe('PC_PARKING_INVALID_TRANSITION');
      expect((error as DomainError).status).toBe(409);
    }
  });

  it('covers every status of the contract', () => {
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...PARKING_SESSION_STATUSES].sort());
  });

  it('final states have no outgoing transitions', () => {
    for (const status of ['closed', 'closed_unpaid', 'closed_free'] as const) {
      expect(isFinalStatus(status)).toBe(true);
      expect(SESSION_TRANSITIONS[status]).toEqual([]);
    }
    expect(isFinalStatus('paid')).toBe(false);
  });

  it('only payable and overstay accept a payment', () => {
    expect(PARKING_SESSION_STATUSES.filter(isPayableStatus)).toEqual(['payable', 'overstay']);
  });
});

describe('deriveSessionState', () => {
  const cases: Array<{
    name: string;
    now: Date;
    exitedAt?: Date | null;
    paidUntil?: Date | null;
    closedReason?: string | null;
    status: ParkingSessionStatus;
    due: number;
  }> = [
    { name: 'inside the free window', now: at(20 * MINUTE_MS), status: 'open', due: 0 },
    { name: 'after the free window', now: at(40 * MINUTE_MS), status: 'payable', due: 2000 },
    {
      name: 'paid and still inside the paid hour',
      now: at(100 * MINUTE_MS),
      paidUntil: at(2 * HOUR_MS),
      status: 'paid',
      due: 0,
    },
    {
      name: 'paid but stayed longer',
      now: at(2 * HOUR_MS + 5 * MINUTE_MS),
      paidUntil: at(2 * HOUR_MS),
      status: 'overstay',
      due: 4000,
    },
    {
      name: 'exit inside the free window',
      now: at(3 * HOUR_MS),
      exitedAt: at(25 * MINUTE_MS),
      status: 'closed',
      due: 0,
    },
    {
      name: 'exit after paying, before paidUntil',
      now: at(3 * HOUR_MS),
      exitedAt: at(100 * MINUTE_MS),
      paidUntil: at(2 * HOUR_MS),
      status: 'closed',
      due: 0,
    },
    {
      name: 'exit with an unpaid amount (paid at the paymat)',
      now: at(3 * HOUR_MS),
      exitedAt: at(50 * MINUTE_MS),
      status: 'closed_unpaid',
      due: 2000,
    },
    {
      name: 'exit after paidUntil without paying again',
      now: at(4 * HOUR_MS),
      exitedAt: at(2 * HOUR_MS + 30 * MINUTE_MS),
      paidUntil: at(2 * HOUR_MS),
      status: 'closed_unpaid',
      due: 4000,
    },
    {
      name: 'air raid closes for free whatever is due',
      now: at(4 * HOUR_MS),
      exitedAt: at(3 * HOUR_MS),
      closedReason: CLOSE_REASONS.airRaid,
      status: 'closed_free',
      due: 10_000,
    },
    {
      name: 'privilege closes for free',
      now: at(4 * HOUR_MS),
      exitedAt: at(50 * MINUTE_MS),
      closedReason: CLOSE_REASONS.privilege,
      status: 'closed_free',
      due: 2000,
    },
    {
      name: 'paidUntil before enteredAt is ignored',
      now: at(40 * MINUTE_MS),
      paidUntil: at(-HOUR_MS),
      status: 'payable',
      due: 2000,
    },
  ];

  it.each(cases.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    const derived = deriveSessionState(
      {
        enteredAt: ENTERED,
        exitedAt: item.exitedAt ?? null,
        paidUntil: item.paidUntil ?? null,
        closedReason: item.closedReason ?? null,
      },
      item.now,
      DEFAULT_PARKING_TARIFF,
    );
    expect(derived.status).toBe(item.status);
    expect(derived.quote.amountDueKopecks).toBe(item.due);
  });
});
