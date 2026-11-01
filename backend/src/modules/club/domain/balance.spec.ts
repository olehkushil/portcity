import {
  type BucketState,
  applyBucketDeltas,
  applyCredit,
  consumeFifo,
  expiringSoon,
  planRefund,
  reduceBuckets,
  spendBlockReason,
  splitExpiredCredits,
} from './balance';

const buckets = (...entries: Array<[string, number]>): BucketState[] =>
  entries.map(([dayKey, remaining]) => ({ dayKey, remaining }));

describe('applyCredit', () => {
  it.each([
    [0, 100, 100, 100],
    [320, 50, 370, 50],
    [-30, 100, 70, 70],
    [-100, 60, -40, 0],
    [-50, 50, 0, 0],
  ])(
    'balance %d + credit %d -> balance %d, %d to bucket',
    (balance, amount, expected, toBucket) => {
      expect(applyCredit(balance, amount)).toEqual({ availableBalance: expected, toBucket });
    },
  );

  it.each([0, -1, 1.5, Number.NaN])('rejects non-positive or fractional amount %p', (amount) => {
    expect(() => applyCredit(0, amount)).toThrow(RangeError);
  });
});

describe('consumeFifo', () => {
  const stock = buckets(['2027-03-01', 50], ['2027-01-15', 30], ['2027-06-30', 100]);

  it.each([
    [10, [['2027-01-15', 10]], 0],
    [30, [['2027-01-15', 30]], 0],
    [
      31,
      [
        ['2027-01-15', 30],
        ['2027-03-01', 1],
      ],
      0,
    ],
    [
      180,
      [
        ['2027-01-15', 30],
        ['2027-03-01', 50],
        ['2027-06-30', 100],
      ],
      0,
    ],
    [
      200,
      [
        ['2027-01-15', 30],
        ['2027-03-01', 50],
        ['2027-06-30', 100],
      ],
      20,
    ],
  ] as Array<[number, Array<[string, number]>, number]>)(
    'spending %d takes the earliest buckets first',
    (amount, taken, shortfall) => {
      expect(consumeFifo(stock, amount)).toEqual({
        taken: taken.map(([dayKey, value]) => ({ dayKey, amount: value })),
        shortfall,
      });
    },
  );

  it('ignores empty buckets and does not mutate the input', () => {
    const input = buckets(['2027-01-01', 0], ['2027-02-01', 5]);
    const copy = structuredClone(input);
    expect(consumeFifo(input, 5)).toEqual({
      taken: [{ dayKey: '2027-02-01', amount: 5 }],
      shortfall: 0,
    });
    expect(input).toEqual(copy);
  });
});

describe('reduceBuckets', () => {
  const stock = buckets(['2027-01-15', 30], ['2027-03-01', 50], ['2027-06-30', 100]);

  it('takes from the preferred bucket first, then from the latest-expiring ones', () => {
    expect(reduceBuckets(stock, 70, '2027-03-01')).toEqual({
      taken: [
        { dayKey: '2027-03-01', amount: 50 },
        { dayKey: '2027-06-30', amount: 20 },
      ],
      shortfall: 0,
    });
  });

  it('falls back to LIFO when the preferred bucket is gone', () => {
    expect(reduceBuckets(stock, 120, '2026-12-31')).toEqual({
      taken: [
        { dayKey: '2027-06-30', amount: 100 },
        { dayKey: '2027-03-01', amount: 20 },
      ],
      shortfall: 0,
    });
  });

  it('reports a shortfall instead of failing when buckets are exhausted', () => {
    expect(reduceBuckets(buckets(['2027-01-15', 10]), 25)).toEqual({
      taken: [{ dayKey: '2027-01-15', amount: 10 }],
      shortfall: 15,
    });
    expect(reduceBuckets([], 5)).toEqual({ taken: [], shortfall: 5 });
  });
});

describe('applyBucketDeltas', () => {
  it('creates, updates and drops buckets, keeping ascending order', () => {
    const result = applyBucketDeltas(buckets(['2027-03-01', 50], ['2027-01-15', 30]), [
      { dayKey: '2027-01-15', delta: -30 },
      { dayKey: '2027-09-09', delta: 12 },
      { dayKey: '2027-03-01', delta: -20 },
    ]);
    expect(result).toEqual(buckets(['2027-03-01', 30], ['2027-09-09', 12]));
  });
});

describe('spendBlockReason', () => {
  const now = new Date('2026-01-15T10:00:00.000Z');

  it.each([
    ['positive balance, no lock', 100, null, null],
    ['zero balance, no lock', 0, null, null],
    [
      'negative balance wins over lock',
      -1,
      new Date('2026-02-01T00:00:00.000Z'),
      'negative_balance',
    ],
    ['active newcomer lock', 100, new Date('2026-01-15T10:00:00.001Z'), 'newcomer_lock'],
    ['lock that just ended', 100, new Date('2026-01-15T10:00:00.000Z'), null],
    ['lock in the past', 100, new Date('2026-01-01T00:00:00.000Z'), null],
  ] as Array<[string, number, Date | null, string | null]>)(
    '%s',
    (_name, balance, lock, expected) => {
      expect(spendBlockReason(balance, lock, now)).toBe(expected);
    },
  );
});

describe('splitExpiredCredits', () => {
  const credits = [
    { id: 'a', amount: 50 },
    { id: 'b', amount: 30 },
    { id: 'c', amount: 20 },
  ];

  it.each([
    ['nothing consumed', 100, [], ['a', 'b', 'c']],
    ['first credit fully consumed', 50, ['a'], ['b', 'c']],
    ['partial second credit stays expired', 40, ['a'], ['b', 'c']],
    ['first two consumed', 20, ['a', 'b'], ['c']],
    ['everything consumed', 0, ['a', 'b', 'c'], []],
    ['drift: remaining above total is clamped', 150, [], ['a', 'b', 'c']],
    ['drift: negative remaining is clamped', -5, ['a', 'b', 'c'], []],
  ] as Array<[string, number, string[], string[]]>)('%s', (_name, remaining, spent, expired) => {
    expect(splitExpiredCredits(credits, remaining)).toEqual({ spent, expired });
  });
});

describe('expiringSoon', () => {
  const stock = buckets(
    ['2026-01-10', 5],
    ['2026-01-20', 40],
    ['2026-02-10', 25],
    ['2026-03-01', 60],
  );

  it('sums buckets inside the window and reports the nearest one', () => {
    expect(expiringSoon(stock, '2026-01-15', '2026-02-14', 30)).toEqual({
      withinDays: 30,
      points: 65,
      nearest: { expiresOn: '2026-01-20', points: 40 },
    });
  });

  it('returns zero when nothing expires in the window', () => {
    expect(expiringSoon(stock, '2026-04-01', '2026-05-01', 30)).toEqual({
      withinDays: 30,
      points: 0,
      nearest: null,
    });
  });
});

describe('planRefund (refund into the original expiry buckets)', () => {
  const base = {
    freshDayKey: '2028-02-15',
    availableBalance: 40,
    todayKey: '2027-02-15',
  };

  it('returns every portion to the bucket it was taken from', () => {
    expect(
      planRefund({
        ...base,
        amount: 80,
        allocations: [
          { dayKey: '2027-11-01', amount: 50 },
          { dayKey: '2027-12-10', amount: 30 },
        ],
      }),
    ).toEqual({
      settled: 0,
      toBuckets: [
        { dayKey: '2027-11-01', amount: 50 },
        { dayKey: '2027-12-10', amount: 30 },
      ],
      expired: [],
      expiredTotal: 0,
    });
  });

  it('puts the part without allocations (older rows, drift) into the fresh bucket', () => {
    expect(planRefund({ ...base, amount: 60, allocations: [] })).toMatchObject({
      toBuckets: [{ dayKey: '2028-02-15', amount: 60 }],
    });
    expect(
      planRefund({ ...base, amount: 60, allocations: [{ dayKey: '2027-11-01', amount: 45 }] }),
    ).toMatchObject({
      toBuckets: [
        { dayKey: '2027-11-01', amount: 45 },
        { dayKey: '2028-02-15', amount: 15 },
      ],
    });
  });

  it('expires the portions whose day already ended (today is still valid)', () => {
    expect(
      planRefund({
        ...base,
        todayKey: '2027-11-20',
        amount: 90,
        allocations: [
          { dayKey: '2027-11-01', amount: 50 },
          { dayKey: '2027-11-20', amount: 10 },
          { dayKey: '2027-12-10', amount: 30 },
        ],
      }),
    ).toEqual({
      settled: 0,
      toBuckets: [
        { dayKey: '2027-11-20', amount: 10 },
        { dayKey: '2027-12-10', amount: 30 },
      ],
      expired: [{ dayKey: '2027-11-01', amount: 50 }],
      expiredTotal: 50,
    });
  });

  it('settles a negative balance first with the earliest-expiring portions', () => {
    expect(
      planRefund({
        ...base,
        todayKey: '2027-11-20',
        availableBalance: -70,
        amount: 90,
        allocations: [
          { dayKey: '2027-11-01', amount: 50 },
          { dayKey: '2027-12-10', amount: 40 },
        ],
      }),
    ).toEqual({
      settled: 70,
      toBuckets: [{ dayKey: '2027-12-10', amount: 20 }],
      expired: [],
      expiredTotal: 0,
    });
  });

  it('never refunds more than the amount, even with inconsistent allocations', () => {
    const plan = planRefund({
      ...base,
      amount: 30,
      allocations: [
        { dayKey: '2027-11-01', amount: 25 },
        { dayKey: '2027-12-10', amount: 25 },
      ],
    });
    expect(plan.toBuckets).toEqual([
      { dayKey: '2027-11-01', amount: 25 },
      { dayKey: '2027-12-10', amount: 5 },
    ]);
  });

  it.each([
    [0, 50, 60, 50],
    [-30, 50, 60, 50],
    [-80, 50, 60, 30],
  ])(
    'keeps sum(buckets) = max(balance, 0): balance %d, valid %d + expired %d -> %d to buckets',
    (availableBalance, valid, expiredPart, expectedBuckets) => {
      const plan = planRefund({
        ...base,
        todayKey: '2027-11-20',
        availableBalance,
        amount: valid + expiredPart,
        allocations: [
          { dayKey: '2027-11-01', amount: expiredPart },
          { dayKey: '2027-12-10', amount: valid },
        ],
      });
      const after = availableBalance + valid + expiredPart - plan.expiredTotal;
      const inBuckets = plan.toBuckets.reduce((sum, portion) => sum + portion.amount, 0);
      expect(inBuckets).toBe(Math.max(after, 0) - Math.max(availableBalance, 0));
      expect(inBuckets).toBe(expectedBuckets);
    },
  );
});
