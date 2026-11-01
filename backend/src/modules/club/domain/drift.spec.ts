import { detectBalanceDrift } from './drift';

const account = (availableBalance: number, pendingBalance: number) => ({
  id: 'acc-1',
  userId: 'user-1',
  availableBalance,
  pendingBalance,
});

describe('detectBalanceDrift', () => {
  it.each([
    ['consistent', account(320, 0), { available: 320, pending: 0 }, 320],
    ['consistent with pending', account(100, 250), { available: 100, pending: 250 }, 100],
    ['negative balance has no buckets', account(-40, 0), { available: -40, pending: 0 }, 0],
    ['zero', account(0, 0), { available: 0, pending: 0 }, 0],
  ])('%s -> null', (_name, cached, ledger, buckets) => {
    expect(detectBalanceDrift(cached, ledger, buckets)).toBeNull();
  });

  it.each([
    ['available', account(330, 0), { available: 320, pending: 0 }, 320, ['available']],
    ['pending', account(320, 10), { available: 320, pending: 0 }, 320, ['pending']],
    ['buckets', account(320, 0), { available: 320, pending: 0 }, 300, ['buckets']],
    [
      'buckets on a negative balance',
      account(-10, 0),
      { available: -10, pending: 0 },
      5,
      ['buckets'],
    ],
    [
      'everything',
      account(1, 2),
      { available: 3, pending: 4 },
      0,
      ['available', 'pending', 'buckets'],
    ],
  ])('%s drift is reported', (_name, cached, ledger, buckets, kinds) => {
    const drift = detectBalanceDrift(cached, ledger, buckets);
    expect(drift?.kinds).toEqual(kinds);
    expect(drift?.accountId).toBe('acc-1');
    expect(drift?.expectedBuckets).toBe(Math.max(ledger.available, 0));
  });
});
