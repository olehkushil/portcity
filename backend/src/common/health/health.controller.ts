import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
  type HealthIndicatorFunction,
  type HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { APP_NAME, appVersion } from '../app-info';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../time/clock';
import { CachedProbe } from './cached-probe';
import { RedisHealthIndicator } from './redis-health.indicator';

/** `/ready` answers from a database ping at most this old. */
export const READY_DB_PING_CACHE_MS = 5_000;
/** Per-IP limit of `/ready` (orchestrator probes poll every few seconds; floods are refused). */
export const READY_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

export class LivenessDto {
  @ApiProperty({ example: 'ok' })
  status: 'ok';

  @ApiProperty({ example: 'portcity-backend' })
  service: string;

  @ApiProperty({ example: '0.1.0' })
  version: string;

  @ApiProperty({ enum: ['api', 'worker'] })
  mode: 'api' | 'worker';

  @ApiProperty({ example: 1234 })
  uptimeSeconds: number;

  @ApiProperty({ example: '2026-01-15T10:00:00.000Z' })
  timestamp: string;
}

/**
 * `/health` (liveness, no dependencies, never throttled) and `/ready` (DB + Redis), outside the API
 * prefix. `/ready` is public, so it is throttled (30/min per IP) and its database ping is cached
 * for 5 s: an anonymous flood cannot turn into a database query per request.
 */
@ApiTags('ops')
@SkipThrottle()
@Controller()
export class HealthController {
  private readonly dbPing: CachedProbe<HealthIndicatorResult>;

  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.dbPing = new CachedProbe(READY_DB_PING_CACHE_MS, () => this.clock.nowMs());
  }

  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ type: LivenessDto })
  liveness(): LivenessDto {
    return {
      status: 'ok',
      service: APP_NAME,
      version: appVersion(),
      mode: this.config.APP_MODE,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: this.clock.now().toISOString(),
    };
  }

  @Get('ready')
  @SkipThrottle({ default: false })
  @Throttle(READY_THROTTLE)
  @ApiOperation({
    summary: 'Readiness probe: database and Redis',
    description: 'Throttled to 30 requests per minute per IP; the database ping is cached for 5 s.',
  })
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    const checks: HealthIndicatorFunction[] = [
      () =>
        this.dbPing.get(() =>
          this.prismaIndicator.pingCheck('database', this.prisma).withTimeout(2_000),
        ),
    ];
    if (this.config.QUEUE_DRIVER === 'redis') {
      checks.push(() => this.redisIndicator.check('redis'));
    }
    return this.health.check(checks);
  }
}
