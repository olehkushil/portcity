import { Module, type OnModuleInit } from '@nestjs/common';
import { envSectionProvider } from '../../common/config/env-section';
import { RECEIPTS_PORT } from '../../common/contracts/receipts';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QueueModule } from '../../common/queue/queue.module';
import { QUEUES } from '../../common/queue/queue.constants';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { ClubModule } from '../club/club.module';
import { ContentModule } from '../content/content.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminReceiptsController } from './controllers/admin-receipts.controller';
import { ReceiptsController } from './controllers/receipts.controller';
import {
  RECEIPTS_PROCESS_JOBS,
  RECEIPTS_SWEEP_EVERY_MS,
  RECEIPTS_SWEEP_SCHEDULE_ID,
  RECEIPTS_VERIFY_EVERY_MS,
  RECEIPTS_VERIFY_SCHEDULE_ID,
} from './jobs/receipts-process.job';
import { RECEIPTS_OUTBOX_ROUTES } from './jobs/receipts-events.handler';
import { ReceiptsEventsProcessor } from './jobs/receipts-events.processor';
import { ReceiptsProcessProcessor } from './jobs/receipts-process.processor';
import { RECEIPTS_CONFIG, receiptsEnvSchema } from './receipts.config';
import { ExpectedPointsService } from './services/expected-points.service';
import { ReceiptModerationService } from './services/receipt-moderation.service';
import { ReceiptPhotoService } from './services/receipt-photo.service';
import { ReceiptPipelineService } from './services/receipt-pipeline.service';
import { ReceiptProcessQueue } from './services/receipt-process.queue';
import { ReceiptSubmissionService } from './services/receipt-submission.service';
import { ReceiptVerificationService } from './services/receipt-verification.service';
import { ReceiptsPortService } from './services/receipts-port.service';
import { ReceiptsRepository } from './services/receipts.repository';
import { NoopTaxReceiptVerifier, TaxReceiptVerifierPort } from './services/tax-receipt-verifier';

/**
 * Receipts: QR parser, submission, risk rules, moderation (/admin/receipts), photos, appeals,
 * queue receipts-process (brief sections 6-9), consumer queue receipts-events (user.deleted).
 * Depends on: content (CONTENT_PORT), club (CLUB_LEDGER_PORT), identity (IDENTITY_PORT: account
 * age for the verification hold; identity is a leaf, the graph stays acyclic); global
 * ADMIN_AUDIT_PORT, FEATURE_FLAGS_PORT, StoragePort, OutboxService. Provides RECEIPTS_PORT
 * (consumed by admin and club). TaxReceiptVerifierPort defaults to the noop adapter.
 */
@Module({
  imports: [
    ContentModule,
    ClubModule,
    IdentityModule,
    QueueModule.registerQueue(QUEUES.receiptsProcess, QUEUES.receiptsEvents),
  ],
  controllers: [ReceiptsController, AdminReceiptsController],
  providers: [
    envSectionProvider(RECEIPTS_CONFIG, receiptsEnvSchema, 'receipts'),
    ReceiptsRepository,
    { provide: TaxReceiptVerifierPort, useClass: NoopTaxReceiptVerifier },
    ReceiptPipelineService,
    ExpectedPointsService,
    ReceiptVerificationService,
    ReceiptPhotoService,
    ReceiptProcessQueue,
    ReceiptSubmissionService,
    ReceiptModerationService,
    ReceiptsPortService,
    ReceiptsProcessProcessor,
    ReceiptsEventsProcessor,
    { provide: RECEIPTS_PORT, useExisting: ReceiptsPortService },
  ],
  exports: [RECEIPTS_PORT],
})
export class ReceiptsModule implements OnModuleInit {
  constructor(
    private readonly schedules: WorkerSchedules,
    private readonly router: OutboxRouter,
  ) {}

  onModuleInit(): void {
    this.router.addRoutes(RECEIPTS_OUTBOX_ROUTES);
    this.schedules.register({
      id: RECEIPTS_SWEEP_SCHEDULE_ID,
      queue: QUEUES.receiptsProcess,
      jobName: RECEIPTS_PROCESS_JOBS.sweep,
      every: RECEIPTS_SWEEP_EVERY_MS,
    });
    this.schedules.register({
      id: RECEIPTS_VERIFY_SCHEDULE_ID,
      queue: QUEUES.receiptsProcess,
      jobName: RECEIPTS_PROCESS_JOBS.verifyHeld,
      every: RECEIPTS_VERIFY_EVERY_MS,
    });
  }
}
