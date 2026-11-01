import { FakeClock } from '../../../common/time/clock';
import {
  InMemoryLookupLimiter,
  type RedisCounter,
  RedisLookupLimiter,
  createLookupLimiter,
} from './lookup-limiter';

describe('InMemoryLookupLimiter', () => {
  it('allows 10 lookups per hour per member', async () => {
    const clock = new FakeClock('2026-01-15T12:00:00Z');
    const limiter = new InMemoryLookupLimiter(clock);
    for (let index = 1; index <= 10; index += 1) {
      const decision = await limiter.consume('u-1', 10);
      expect(decision).toMatchObject({ allowed: true, remaining: 10 - index });
    }
    const blocked = await limiter.consume('u-1', 10);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 });
    expect(blocked.resetAt.toISOString()).toBe('2026-01-15T13:00:00.000Z');
    expect(await limiter.consume('u-2', 10)).toMatchObject({ allowed: true, remaining: 9 });
    expect(await limiter.peek('u-1', 10)).toMatchObject({ allowed: false, remaining: 0 });

    clock.advanceMinutes(60);
    expect(await limiter.consume('u-1', 10)).toMatchObject({ allowed: true, remaining: 9 });
  });
});

class FakeRedis implements RedisCounter {
  readonly values = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  fail = false;

  async incr(key: string): Promise<number> {
    this.check();
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    this.check();
    this.ttls.set(key, milliseconds);
    return 1;
  }

  async pttl(key: string): Promise<number> {
    this.check();
    return this.ttls.get(key) ?? -1;
  }

  async get(key: string): Promise<string | null> {
    this.check();
    const value = this.values.get(key);
    return value === undefined ? null : String(value);
  }

  private check(): void {
    if (this.fail) {
      throw new Error('connection refused');
    }
  }
}

describe('RedisLookupLimiter', () => {
  it('counts in Redis with a one-hour expiry', async () => {
    const clock = new FakeClock('2026-01-15T12:00:00Z');
    const redis = new FakeRedis();
    const limiter = new RedisLookupLimiter(redis, clock, new InMemoryLookupLimiter(clock));
    expect(await limiter.consume('u-1', 2)).toMatchObject({ allowed: true, remaining: 1 });
    expect(redis.ttls.get('portcity:parking:lookups:u-1')).toBe(3_600_000);
    expect(await limiter.consume('u-1', 2)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await limiter.consume('u-1', 2)).toMatchObject({ allowed: false, remaining: 0 });
    expect(await limiter.peek('u-1', 2)).toMatchObject({ allowed: false });
  });

  it('falls back to the in-process quota when Redis fails', async () => {
    const clock = new FakeClock('2026-01-15T12:00:00Z');
    const redis = new FakeRedis();
    redis.fail = true;
    const limiter = new RedisLookupLimiter(redis, clock, new InMemoryLookupLimiter(clock));
    expect(await limiter.consume('u-1', 1)).toMatchObject({ allowed: true });
    expect(await limiter.consume('u-1', 1)).toMatchObject({ allowed: false });
    expect(await limiter.peek('u-1', 1)).toMatchObject({ allowed: false });
  });

  it('keyed windows: claims per hour and verification attempts per 24 h (findings 8 and 14)', async () => {
    const clock = new FakeClock('2026-01-15T12:00:00Z');
    const redis = new FakeRedis();
    const limiter = new RedisLookupLimiter(redis, clock, new InMemoryLookupLimiter(clock));
    expect(await limiter.consumeWindow('verify:u-1:AC1234BC', 1, 86_400_000)).toMatchObject({
      allowed: true,
    });
    expect(redis.ttls.get('portcity:parking:quota:verify:u-1:AC1234BC')).toBe(86_400_000);
    expect(await limiter.consumeWindow('verify:u-1:AC1234BC', 1, 86_400_000)).toMatchObject({
      allowed: false,
    });
    redis.fail = true;
    expect(await limiter.consumeWindow('claim:u-1', 1, 3_600_000)).toMatchObject({
      allowed: true,
    });
    expect(await limiter.consumeWindow('claim:u-1', 1, 3_600_000)).toMatchObject({
      allowed: false,
    });

    const memory = new InMemoryLookupLimiter(clock);
    expect(await memory.consumeWindow('claim:u-2', 1, 3_600_000)).toMatchObject({
      allowed: true,
      remaining: 0,
      resetAt: new Date('2026-01-15T13:00:00Z'),
    });
    expect(await memory.consumeWindow('claim:u-2', 1, 3_600_000)).toMatchObject({ allowed: false });
    // Separate namespace from the unverified-plate lookups of the same member.
    expect(await memory.consume('u-2', 1)).toMatchObject({ allowed: true });
    clock.set(new Date('2026-01-15T13:00:01Z'));
    expect(await memory.consumeWindow('claim:u-2', 1, 3_600_000)).toMatchObject({ allowed: true });
  });

  it('createLookupLimiter picks Redis only with QUEUE_DRIVER=redis', () => {
    const clock = new FakeClock();
    const redis = new FakeRedis();
    expect(
      createLookupLimiter(
        { QUEUE_DRIVER: 'redis' } as Parameters<typeof createLookupLimiter>[0],
        redis,
        clock,
      ),
    ).toBeInstanceOf(RedisLookupLimiter);
    expect(
      createLookupLimiter(
        { QUEUE_DRIVER: 'memory' } as Parameters<typeof createLookupLimiter>[0],
        redis,
        clock,
      ),
    ).toBeInstanceOf(InMemoryLookupLimiter);
  });
});
