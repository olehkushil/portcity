import { Module, type OnModuleInit } from '@nestjs/common';
import { CLUB_LEDGER_PORT } from '../../common/contracts/club';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { IdentityModule } from '../identity/identity.module';
import { clubConfigProvider } from './club.config';
import {
  AdminClubAccountsController,
  AdminRuleSetsController,
} from './controllers/admin-club.controller';
import { ClubController } from './controllers/club.controller';
import {
  ClubEventsProcessor,
  PointsExpireProcessor,
  PointsReleaseHoldsProcessor,
} from './jobs/club.processors';
import { CLUB_CONSUMED_EVENTS, CLUB_SCHEDULES } from './jobs/job-names';
import { ClubAccountService } from './services/club-account.service';
import { ClubJobsService } from './services/club-jobs.service';
import { ClubRepository } from './services/club.repository';
import { LedgerService } from './services/ledger.service';
import { PendingModerationReader } from './services/pending-moderation.reader';
import { PrismaClubRepository } from './services/prisma-club.repository';
import { RuleSetsService } from './services/rule-sets.service';

/**
 * Club: loyalty accounts, the append-only points ledger (CLUB_LEDGER_PORT = LedgerService),
 * FIFO expiry buckets, holds, welcome bonuses, versioned rule sets with /admin CRUD.
 * Queues: points-release-holds (hourly), points-expire (daily 03:30 Kyiv expiry + reminders,
 * nightly drift check), club-events (consumes user.registered, user.profile_completed,
 * receipt.credited). Depends on identity (IDENTITY_PORT, member code for the card QR).
 * Consumed by receipts, rewards and admin through CLUB_LEDGER_PORT.
 */
@Module({
  imports: [
    IdentityModule,
    QueueModule.registerQueue(QUEUES.pointsReleaseHolds, QUEUES.pointsExpire, QUEUES.clubEvents),
  ],
  controllers: [ClubController, AdminRuleSetsController, AdminClubAccountsController],
  providers: [
    clubConfigProvider,
    { provide: ClubRepository, useClass: PrismaClubRepository },
    RuleSetsService,
    LedgerService,
    PendingModerationReader,
    ClubAccountService,
    ClubJobsService,
    PointsReleaseHoldsProcessor,
    PointsExpireProcessor,
    ClubEventsProcessor,
    { provide: CLUB_LEDGER_PORT, useExisting: LedgerService },
  ],
  exports: [CLUB_LEDGER_PORT, LedgerService, ClubAccountService, RuleSetsService],
})
export class ClubModule implements OnModuleInit {
  constructor(
    private readonly router: OutboxRouter,
    private readonly schedules: WorkerSchedules,
  ) {}

  onModuleInit(): void {
    for (const type of CLUB_CONSUMED_EVENTS) {
      this.router.addRoute(type, QUEUES.clubEvents);
    }
    for (const schedule of CLUB_SCHEDULES) {
      this.schedules.register({ ...schedule });
    }
  }
}
