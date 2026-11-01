import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AuditModule } from './common/audit/audit.module';
import { AuthModule } from './common/auth/auth.module';
import { AppConfigModule } from './common/config/config.module';
import { ProblemDetailsFilter } from './common/errors/problem-details.filter';
import { FeatureFlagsModule } from './common/feature-flags/feature-flags.module';
import { HealthModule } from './common/health/health.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { LoggingModule } from './common/logging/logging.module';
import { MaintenanceModule } from './common/maintenance/maintenance.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueModule } from './common/queue/queue.module';
import { RedisModule } from './common/redis/redis.module';
import { StorageModule } from './common/storage/storage.module';
import { ThrottlingModule } from './common/throttling/throttling.module';
import { TimeModule } from './common/time/time.module';
import { createValidationPipe } from './common/validation/validation.pipe';
import { AdminModule } from './modules/admin/admin.module';
import { ClubModule } from './modules/club/club.module';
import { ContentModule } from './modules/content/content.module';
import { IdentityModule } from './modules/identity/identity.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ParkingModule } from './modules/parking/parking.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PromosModule } from './modules/promos/promos.module';
import { ReceiptsModule } from './modules/receipts/receipts.module';
import { RewardsModule } from './modules/rewards/rewards.module';

/**
 * Root module shared by the API (src/main.ts) and the worker (src/worker.ts).
 * Infrastructure modules are global. Feature modules import each other along the dependency
 * graph documented in docs/FOUNDATION_SUMMARY.md (leaves first): identity, content, payments,
 * club, notifications, receipts, parking, rewards, promos, admin. The order below is cosmetic.
 */
@Module({
  imports: [
    // infrastructure (common layer)
    AppConfigModule,
    LoggingModule,
    TimeModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    StorageModule,
    AuthModule,
    IdempotencyModule,
    OutboxModule,
    AuditModule,
    FeatureFlagsModule,
    MaintenanceModule,
    ThrottlingModule,
    HealthModule,
    // feature modules (each src/modules/<name>/<name>.module.ts is replaced by its builder)
    IdentityModule,
    ContentModule,
    PaymentsModule,
    ClubModule,
    NotificationsModule,
    ReceiptsModule,
    ParkingModule,
    RewardsModule,
    PromosModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
