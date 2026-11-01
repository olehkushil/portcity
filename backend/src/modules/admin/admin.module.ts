import { Module, type OnModuleInit } from '@nestjs/common';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { ClubModule } from '../club/club.module';
import { ContentModule } from '../content/content.module';
import { IdentityModule } from '../identity/identity.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ParkingModule } from '../parking/parking.module';
import { PaymentsModule } from '../payments/payments.module';
import { PromosModule } from '../promos/promos.module';
import { ReceiptsModule } from '../receipts/receipts.module';
import { RewardsModule } from '../rewards/rewards.module';
import { AdjustmentsController } from './controllers/adjustments.controller';
import { AdminSupportRequestsController } from './controllers/admin-support-requests.controller';
import { AuditController } from './controllers/audit.controller';
import { FeatureFlagsController } from './controllers/feature-flags.controller';
import { ReportsController } from './controllers/reports.controller';
import { SupportController } from './controllers/support.controller';
import { ADMIN_OUTBOX_ROUTES } from './jobs/admin-events.handler';
import { AdminEventsProcessor } from './jobs/admin-events.processor';
import {
  DEFAULT_CATCH_UP_DAYS,
  REPORTS_NIGHTLY_CRON,
  REPORTS_NIGHTLY_JOBS,
  REPORTS_NIGHTLY_SCHEDULE_ID,
} from './jobs/reports-nightly.job';
import { ReportsNightlyProcessor } from './jobs/reports-nightly.processor';
import { AdjustmentsService } from './services/adjustments.service';
import { AuditLogService } from './services/audit-log.service';
import { FeatureFlagsAdminService } from './services/feature-flags-admin.service';
import { ReportsService } from './services/reports.service';
import { SupportRequestsService } from './services/support-requests.service';

/**
 * Admin: manual adjustments (four eyes, cumulative self-approval caps), audit log reads, feature
 * flag CRUD, daily reports (queue reports-nightly) and member support requests (POST/GET
 * /support/requests, /admin/support-requests; event support.request_created). RBAC guards live in src/common/auth; the audit writer and the
 * feature flag reader live in src/common (ADMIN_AUDIT_PORT, FEATURE_FLAGS_PORT, global).
 * Admin users and /admin/auth/* belong to identity; entity CRUD belongs to each owner module.
 *
 * Consumes: CLUB_LEDGER_PORT (adjustments, points stats), RECEIPTS_PORT, VOUCHER_ISSUER_PORT and
 * PARKING_PORT (daily report); outbox `user.deleted` on the admin-events queue (texts and photos
 * of the member's support requests are erased). Provides no port (leaf of the module graph).
 */
@Module({
  imports: [
    IdentityModule,
    ContentModule,
    PaymentsModule,
    ClubModule,
    NotificationsModule,
    ReceiptsModule,
    ParkingModule,
    RewardsModule,
    PromosModule,
    QueueModule.registerQueue(QUEUES.reportsNightly, QUEUES.adminEvents),
  ],
  controllers: [
    AdjustmentsController,
    AuditController,
    FeatureFlagsController,
    ReportsController,
    SupportController,
    AdminSupportRequestsController,
  ],
  providers: [
    AdjustmentsService,
    AuditLogService,
    FeatureFlagsAdminService,
    ReportsService,
    SupportRequestsService,
    ReportsNightlyProcessor,
    AdminEventsProcessor,
  ],
  exports: [
    AdjustmentsService,
    AuditLogService,
    FeatureFlagsAdminService,
    ReportsService,
    SupportRequestsService,
  ],
})
export class AdminModule implements OnModuleInit {
  constructor(
    private readonly schedules: WorkerSchedules,
    private readonly router: OutboxRouter,
  ) {}

  onModuleInit(): void {
    this.router.addRoutes(ADMIN_OUTBOX_ROUTES);
    this.schedules.register({
      id: REPORTS_NIGHTLY_SCHEDULE_ID,
      queue: QUEUES.reportsNightly,
      jobName: REPORTS_NIGHTLY_JOBS.computeDay,
      pattern: REPORTS_NIGHTLY_CRON,
      data: { catchUpDays: DEFAULT_CATCH_UP_DAYS },
    });
  }
}
