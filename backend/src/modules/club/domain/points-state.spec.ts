import { POINTS_TX_STATES, type PointsTxState } from '../../../common/contracts/club';
import {
  AVAILABLE_SUM_STATES,
  assertTransition,
  canTransition,
  isFinalState,
  planReversal,
  type ReversalPlan,
  type ReversibleEntry,
} from './points-state';

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('points state machine', () => {
  const allowed: Array<[PointsTxState, PointsTxState]> = [
    ['pending', 'available'],
    ['pending', 'cancelled'],
    ['available', 'spent'],
    ['available', 'expired'],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('forbids every other transition (table over the full state space)', () => {
    const allowedSet = new Set(allowed.map(([from, to]) => `${from}>${to}`));
    for (const from of POINTS_TX_STATES) {
      for (const to of POINTS_TX_STATES) {
        const expected = allowedSet.has(`${from}>${to}`);
        expect([from, to, canTransition(from, to)]).toEqual([from, to, expected]);
      }
    }
  });

  it('assertTransition throws PC_POINTS_INVALID_TRANSITION with details', () => {
    expect(thrownBy(() => assertTransition('spent', 'available', 'tx-1'))).toMatchObject({
      code: 'PC_POINTS_INVALID_TRANSITION',
      status: 409,
      details: { txId: 'tx-1', from: 'spent', to: 'available' },
    });
  });

  it.each([
    ['pending', false],
    ['available', false],
    ['spent', true],
    ['expired', true],
    ['cancelled', true],
  ] as Array<[PointsTxState, boolean]>)('isFinalState(%s) = %s', (state, expected) => {
    expect(isFinalState(state)).toBe(expected);
  });

  it('available balance sums rows in available, spent and expired states (seed convention)', () => {
    expect([...AVAILABLE_SUM_STATES].sort()).toEqual(['available', 'expired', 'spent']);
  });
});

describe('planReversal', () => {
  const entry = (partial: Partial<ReversibleEntry>): ReversibleEntry => ({
    id: 'tx',
    type: 'earn',
    state: 'available',
    amount: 10,
    ...partial,
  });

  const cases: Array<[string, ReversibleEntry, ReversalPlan | 'throws']> = [
    ['pending credit is cancelled in place', entry({ state: 'pending' }), 'cancel'],
    ['available credit gets a reverse row', entry({ state: 'available' }), 'reverse'],
    ['consumed credit gets a reverse row', entry({ state: 'spent' }), 'reverse'],
    ['cancelled credit is a no-op', entry({ state: 'cancelled' }), 'noop'],
    ['expired credit cannot be reversed', entry({ state: 'expired' }), 'throws'],
    ['spend gets a refund', entry({ type: 'spend', state: 'spent', amount: -10 }), 'refund'],
    ['expire row gets a refund', entry({ type: 'expire', state: 'expired', amount: -5 }), 'refund'],
    ['reverse row gets a refund', entry({ type: 'reverse', state: 'spent', amount: -7 }), 'refund'],
    [
      'negative adjust gets a refund',
      entry({ type: 'adjust', state: 'available', amount: -3 }),
      'refund',
    ],
    ['refund row (credit) gets a reverse row', entry({ type: 'refund', amount: 4 }), 'reverse'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    if (expected === 'throws') {
      expect(thrownBy(() => planReversal(input))).toMatchObject({
        code: 'PC_POINTS_INVALID_TRANSITION',
      });
      return;
    }
    expect(planReversal(input)).toBe(expected);
  });
});
