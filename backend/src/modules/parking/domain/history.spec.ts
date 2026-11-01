import { appPaidKopecks, kyivMonthRange, paidVia } from './history';

const base = {
  status: 'closed' as const,
  source: 'provider' as const,
  paidUntil: null,
  amountPaidKopecks: 0,
  stayTotalKopecks: 0,
  appPaidKopecks: 0,
};

describe('paidVia', () => {
  it.each([
    ['app payment kept', { appPaidKopecks: 6000, amountPaidKopecks: 6000 }, 'app'],
    ['air raid / privilege', { status: 'closed_free' as const, stayTotalKopecks: 6000 }, 'free'],
    [
      'operator reports a paymat payment',
      { amountPaidKopecks: 6000, stayTotalKopecks: 6000 },
      'paymat',
    ],
    [
      'timer marked paid at the paymat',
      { source: 'info_timer' as const, paidUntil: new Date(), stayTotalKopecks: 6000 },
      'paymat',
    ],
    ['left within the free minutes', {}, 'free'],
    ['left without paying', { status: 'closed_unpaid' as const, stayTotalKopecks: 6000 }, 'none'],
    ['still inside, nothing paid', { status: 'payable' as const, stayTotalKopecks: 6000 }, 'none'],
  ])('%s -> %s', (_name, input, expected) => {
    expect(paidVia({ ...base, ...input })).toBe(expected);
  });
});

describe('appPaidKopecks', () => {
  it('counts kept payments minus refunds only', () => {
    expect(
      appPaidKopecks([
        { status: 'succeeded', amountKopecks: 6000 },
        { status: 'partially_refunded', amountKopecks: 4000, refundedKopecks: 1000 },
        { status: 'refunded', amountKopecks: 4000, refundedKopecks: 4000 },
        { status: 'failed', amountKopecks: 6000 },
      ]),
    ).toBe(9000);
  });
});

describe('kyivMonthRange', () => {
  it.each([
    ['2026-01', '2025-12-31T22:00:00.000Z', '2026-01-31T22:00:00.000Z'],
    // Summer time starts on the last Sunday of March.
    ['2026-03', '2026-02-28T22:00:00.000Z', '2026-03-31T21:00:00.000Z'],
    ['2026-12', '2026-11-30T22:00:00.000Z', '2026-12-31T22:00:00.000Z'],
  ])('%s', (month, from, to) => {
    expect(kyivMonthRange(month)).toEqual({ from: new Date(from), to: new Date(to) });
  });

  it.each(['2026-13', '2026-1', 'oct'])('rejects %s', (month) => {
    expect(kyivMonthRange(month)).toBeNull();
  });
});
