import { FailureBurstTracker } from './failure-burst';

describe('FailureBurstTracker', () => {
  it('reports a burst once, when the count in the window reaches the threshold', () => {
    const tracker = new FailureBurstTracker(60_000, 3);
    expect(tracker.hit('203.0.113.7', 0)).toEqual({ count: 1, burst: false });
    expect(tracker.hit('203.0.113.7', 10_000)).toEqual({ count: 2, burst: false });
    expect(tracker.hit('203.0.113.7', 20_000)).toEqual({ count: 3, burst: true });
    expect(tracker.hit('203.0.113.7', 30_000)).toEqual({ count: 4, burst: false });
    expect(tracker.hit('198.51.100.1', 30_000)).toEqual({ count: 1, burst: false });
  });

  it('forgets hits older than the window', () => {
    const tracker = new FailureBurstTracker(60_000, 3);
    tracker.hit('k', 0);
    tracker.hit('k', 1000);
    expect(tracker.hit('k', 61_500)).toEqual({ count: 1, burst: false });
  });

  it('bounds the number of tracked keys', () => {
    const tracker = new FailureBurstTracker(60_000, 3, 2);
    tracker.hit('a', 0);
    tracker.hit('b', 0);
    tracker.hit('c', 0);
    expect(tracker.trackedKeys).toBe(2);
    expect(tracker.hit('a', 1)).toEqual({ count: 1, burst: false });
  });
});
