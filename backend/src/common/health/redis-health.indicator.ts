import { Inject, Injectable } from '@nestjs/common';
import { type HealthCheckAttempt, HealthIndicatorService } from '@nestjs/terminus';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  check(key = 'redis'): HealthCheckAttempt<string> {
    return this.indicators
      .check(key)
      .attempt(async () => {
        const reply: string = await this.redis.ping();
        if (reply !== 'PONG') {
          throw new Error(`Unexpected PING reply: ${reply}`);
        }
      })
      .withTimeout(2_000);
  }
}
