import { Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, type AppConfig } from '../config';
import { ipRateLimitKey } from './ip-key';

/**
 * ThrottlerGuard keyed by `ipRateLimitKey(req.ip)`: IPv4 addresses as they are, IPv6 clients by
 * their /64 network (one subscriber cannot multiply its quota by rotating addresses). `req.ip`
 * honours TRUST_PROXY (hop count or trusted networks, see src/common/config/trust-proxy.ts).
 */
@Injectable()
export class NetworkThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = typeof req['ip'] === 'string' ? req['ip'] : undefined;
    return Promise.resolve(ipRateLimitKey(ip) ?? 'unknown');
  }
}

/**
 * Global rate limit (default 60 requests per minute per IP, brief section 1).
 * Stricter per-route limits: `@Throttle({ default: { limit: 3, ttl: 600_000 } })`;
 * opt out with `@SkipThrottle()`. Storage is in-process; see ARCHITECTURE.md for the Redis option.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.THROTTLE_TTL_SECONDS * 1000,
            limit: config.THROTTLE_LIMIT,
          },
        ],
        errorMessage: 'Too many requests',
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: NetworkThrottlerGuard }],
})
export class ThrottlingModule {}
