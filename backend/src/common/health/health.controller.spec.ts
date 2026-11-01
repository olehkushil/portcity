import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaHealthIndicator, TerminusModule } from '@nestjs/terminus';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { APP_CONFIG } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { NetworkThrottlerGuard } from '../throttling/throttling.module';
import { Clock, FakeClock } from '../time/clock';
import { CachedProbe } from './cached-probe';
import { HealthController, READY_DB_PING_CACHE_MS } from './health.controller';
import { RedisHealthIndicator } from './redis-health.indicator';

describe('CachedProbe', () => {
  it('shares one run within the window, including concurrent callers, then runs again', async () => {
    let now = 0;
    let runs = 0;
    const probe = new CachedProbe<number>(5_000, () => now);
    const load = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    const [a, b] = await Promise.all([probe.get(load), probe.get(load)]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    now = 4_999;
    await expect(probe.get(load)).resolves.toBe(1);
    now = 5_000;
    await expect(probe.get(load)).resolves.toBe(2);
    probe.reset();
    await expect(probe.get(load)).resolves.toBe(3);
  });

  it('caches failures for the window as well', async () => {
    let runs = 0;
    const probe = new CachedProbe<number>(5_000, () => 0);
    const failing = (): Promise<number> => {
      runs += 1;
      return Promise.reject(new Error('db down'));
    };
    await expect(probe.get(failing)).rejects.toThrow('db down');
    await expect(probe.get(failing)).rejects.toThrow('db down');
    expect(runs).toBe(1);
  });
});

describe('HealthController (/ready throttle and ping cache)', () => {
  let app: INestApplication;
  let clock: FakeClock;
  let pings: number;

  beforeEach(async () => {
    clock = new FakeClock('2026-03-10T10:00:00.000Z');
    pings = 0;
    const prismaIndicator = {
      pingCheck: (key: string) => ({
        withTimeout: () => {
          pings += 1;
          return Promise.resolve({ [key]: { status: 'up' } });
        },
      }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        TerminusModule.forRoot({ logger: false }),
        // A generous global limit: only the route-level limit of /ready can trigger here.
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 1_000 }] }),
      ],
      controllers: [HealthController],
      providers: [
        { provide: APP_GUARD, useClass: NetworkThrottlerGuard },
        { provide: PrismaHealthIndicator, useValue: prismaIndicator },
        { provide: PrismaService, useValue: {} },
        { provide: RedisHealthIndicator, useValue: { check: jest.fn() } },
        { provide: Clock, useValue: clock },
        { provide: APP_CONFIG, useValue: { APP_MODE: 'api', QUEUE_DRIVER: 'memory' } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const server = (): Server => app.getHttpServer() as Server;

  it('pings the database at most once per 5 seconds', async () => {
    await request(server()).get('/ready').expect(200);
    await request(server()).get('/ready').expect(200);
    expect(pings).toBe(1);
    clock.advance(READY_DB_PING_CACHE_MS);
    const response = await request(server()).get('/ready').expect(200);
    expect(pings).toBe(2);
    expect(response.body).toMatchObject({ status: 'ok', info: { database: { status: 'up' } } });
  });

  it('throttles /ready to 30 requests per minute per IP but never /health', async () => {
    for (let index = 0; index < 30; index += 1) {
      await request(server()).get('/ready').expect(200);
    }
    await request(server()).get('/ready').expect(429);
    for (let index = 0; index < 40; index += 1) {
      await request(server()).get('/health').expect(200);
    }
  });
});
