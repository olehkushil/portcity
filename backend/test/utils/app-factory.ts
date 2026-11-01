import 'reflect-metadata';
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureHttpApp } from '../../src/app.setup';
import { AdminAccessGate } from '../../src/common/auth/admin-access';
import { TokenService } from '../../src/common/auth/token.service';
import { APP_CONFIG, type AppConfig, getValidatedEnv } from '../../src/common/config';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { QueueRegistry } from '../../src/common/queue/queue-registry.service';
import { StoragePort } from '../../src/common/storage/storage.port';
import { Clock, FakeClock } from '../../src/common/time/clock';

export interface TestAppOptions {
  /** Overrides merged into the validated test configuration (APP_CONFIG provider). */
  config?: Partial<AppConfig>;
  /** Fixed clock (default FakeClock at 2026-01-15T10:00:00Z); `null` keeps the system clock. */
  clock?: FakeClock | null;
  /** Hook for `overrideProvider(...)` and friends. */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /**
   * Keep the AdminGuard check that the admin behind a token is still active (identity lookup).
   * Off by default because most suites sign admin tokens for ids that are not stored anywhere.
   */
  adminAccessCheck?: boolean;
}

export interface TestApp {
  app: NestExpressApplication;
  moduleRef: TestingModule;
  /** Pass to supertest: `request(testApp.server).get('/health')`. */
  server: Server;
  config: AppConfig;
  clock: FakeClock | null;
  prisma: PrismaService;
  queues: QueueRegistry;
  storage: StoragePort;
  tokens: TokenService;
  memberToken(userId: string, deviceId?: string): string;
  adminToken(adminId: string, roles?: string[]): string;
  close(): Promise<void>;
}

/**
 * Boots the full AppModule the way src/main.ts does, but with QUEUE_DRIVER=memory,
 * STORAGE_DRIVER=memory and PRISMA_LAZY_CONNECT=true (see test/setup-env.js), so no
 * external service is required. Set DATABASE_URL to run against PostgreSQL.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const clock = options.clock === undefined ? new FakeClock() : options.clock;

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.config) {
    builder = builder
      .overrideProvider(APP_CONFIG)
      .useValue({ ...getValidatedEnv(), ...options.config });
  }
  if (clock) {
    builder = builder.overrideProvider(Clock).useValue(clock);
  }
  if (options.configure) {
    builder = options.configure(builder);
  }

  const moduleRef = await builder.compile();
  // rawBody as in src/main.ts: webhook signature checks read request.rawBody.
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
    rawBody: true,
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  configureHttpApp(app, config);
  await app.init();
  // Admin tokens in e2e tests usually belong to no stored account, so the shared AdminGuard's
  // "admin still active" lookup is off unless a test asks for it.
  app.get(AdminAccessGate).setEnabled(options.adminAccessCheck === true);

  const tokens = app.get(TokenService);
  return {
    app,
    moduleRef,
    server: app.getHttpServer(),
    config,
    clock,
    prisma: app.get(PrismaService),
    queues: app.get(QueueRegistry),
    storage: app.get(StoragePort),
    tokens,
    memberToken: (userId, deviceId) =>
      tokens.signAccessToken({ sub: userId, type: 'member', ...(deviceId ? { deviceId } : {}) })
        .token,
    adminToken: (adminId, roles = ['owner']) =>
      tokens.signAccessToken({ sub: adminId, type: 'admin', roles }).token,
    close: () => app.close(),
  };
}
