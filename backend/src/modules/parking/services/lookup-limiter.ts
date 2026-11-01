import { type FactoryProvider, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { Clock } from '../../../common/time/clock';

export const LOOKUP_WINDOW_MS = 3_600_000;

export interface LookupDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
}

/**
 * Per-member quota for session lookups of unverified plates (brief section 8: amount and paid
 * period only, 10 requests per hour). Fixed one-hour windows aligned to the first lookup.
 */
export abstract class UnverifiedLookupLimiter {
  abstract consume(userId: string, limit: number): Promise<LookupDecision>;
  abstract peek(userId: string, limit: number): Promise<LookupDecision>;
  /**
   * Generic fixed-window quota under its own key namespace, e.g. `claim:<userId>` (10 talon
   * claims per hour) or `verify:<userId>:<plate>` (5 verification attempts per 24 h).
   */
  abstract consumeWindow(key: string, limit: number, windowMs: number): Promise<LookupDecision>;
}

interface WindowState {
  startedAt: number;
  count: number;
}

/** Process-local quota (tests, single API instance, fallback when Redis fails). */
export class InMemoryLookupLimiter extends UnverifiedLookupLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly keyed = new Map<string, WindowState>();

  constructor(private readonly clock: Clock) {
    super();
  }

  async consumeWindow(key: string, limit: number, windowMs: number): Promise<LookupDecision> {
    const now = this.clock.nowMs();
    const existing = this.keyed.get(key);
    const state =
      existing && existing.startedAt + windowMs > now ? existing : { startedAt: now, count: 0 };
    const allowed = state.count < limit;
    if (allowed) {
      state.count += 1;
    }
    this.keyed.set(key, state);
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - state.count),
      resetAt: new Date(state.startedAt + windowMs),
    };
  }

  async consume(userId: string, limit: number): Promise<LookupDecision> {
    const now = this.clock.nowMs();
    const state = this.current(userId, now);
    if (state.count >= limit) {
      return this.decision(state, limit, false);
    }
    state.count += 1;
    this.windows.set(userId, state);
    return this.decision(state, limit, true);
  }

  async peek(userId: string, limit: number): Promise<LookupDecision> {
    const state = this.current(userId, this.clock.nowMs());
    return this.decision(state, limit, state.count < limit);
  }

  private current(userId: string, now: number): WindowState {
    const existing = this.windows.get(userId);
    if (existing && existing.startedAt + LOOKUP_WINDOW_MS > now) {
      return existing;
    }
    return { startedAt: now, count: 0 };
  }

  private decision(state: WindowState, limit: number, allowed: boolean): LookupDecision {
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - state.count),
      resetAt: new Date(state.startedAt + LOOKUP_WINDOW_MS),
    };
  }
}

/** Minimal slice of ioredis used by the shared quota. */
export interface RedisCounter {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

/** Quota shared by all API replicas (INCR + PEXPIRE); falls back to memory when Redis fails. */
export class RedisLookupLimiter extends UnverifiedLookupLimiter {
  private readonly logger = new Logger(RedisLookupLimiter.name);

  constructor(
    private readonly redis: RedisCounter,
    private readonly clock: Clock,
    private readonly fallback: UnverifiedLookupLimiter,
    private readonly prefix = 'portcity:parking:lookups:',
  ) {
    super();
  }

  async consume(userId: string, limit: number): Promise<LookupDecision> {
    const key = this.prefix + userId;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.pexpire(key, LOOKUP_WINDOW_MS);
      }
      const ttl = await this.redis.pttl(key);
      const resetAt = new Date(this.clock.nowMs() + (ttl > 0 ? ttl : LOOKUP_WINDOW_MS));
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt,
      };
    } catch (error) {
      this.logger.warn(
        `Redis quota unavailable, using the in-process quota: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fallback.consume(userId, limit);
    }
  }

  async consumeWindow(key: string, limit: number, windowMs: number): Promise<LookupDecision> {
    const redisKey = `portcity:parking:quota:${key}`;
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.pexpire(redisKey, windowMs);
      }
      const ttl = await this.redis.pttl(redisKey);
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt: new Date(this.clock.nowMs() + (ttl > 0 ? ttl : windowMs)),
      };
    } catch (error) {
      this.logger.warn(
        `Redis quota unavailable, using the in-process quota: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fallback.consumeWindow(key, limit, windowMs);
    }
  }

  async peek(userId: string, limit: number): Promise<LookupDecision> {
    const key = this.prefix + userId;
    try {
      const raw = await this.redis.get(key);
      const count = raw ? Number(raw) : 0;
      const ttl = await this.redis.pttl(key);
      return {
        allowed: count < limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt: new Date(this.clock.nowMs() + (ttl > 0 ? ttl : LOOKUP_WINDOW_MS)),
      };
    } catch {
      return this.fallback.peek(userId, limit);
    }
  }
}

/** Redis-backed quota when the deployment runs Redis (QUEUE_DRIVER=redis), memory otherwise. */
export function createLookupLimiter(
  config: AppConfig,
  redis: RedisCounter,
  clock: Clock,
): UnverifiedLookupLimiter {
  const memory = new InMemoryLookupLimiter(clock);
  return config.QUEUE_DRIVER === 'redis' ? new RedisLookupLimiter(redis, clock, memory) : memory;
}

export const lookupLimiterFactory: FactoryProvider<UnverifiedLookupLimiter> = {
  provide: UnverifiedLookupLimiter,
  inject: [APP_CONFIG, REDIS_CLIENT, Clock],
  useFactory: createLookupLimiter,
};
