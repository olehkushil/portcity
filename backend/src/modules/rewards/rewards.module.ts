import { Module, type OnModuleInit } from '@nestjs/common';
import { VOUCHER_ISSUER_PORT } from '../../common/contracts/rewards';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { ClubModule } from '../club/club.module';
import { ContentModule } from '../content/content.module';
import { ParkingModule } from '../parking/parking.module';
import { ValidatorGuard } from './auth/validator.guard';
import { AdminRewardsController } from './controllers/admin-rewards.controller';
import { AdminValidatorDevicesController } from './controllers/admin-validator-devices.controller';
import { AdminVouchersController } from './controllers/admin-vouchers.controller';
import { RewardsController } from './controllers/rewards.controller';
import { ValidatorController } from './controllers/validator.controller';
import { VouchersController } from './controllers/vouchers.controller';
import {
  REWARDS_JOBS,
  VOUCHERS_EXPIRE_EVERY_MS,
  VOUCHERS_EXPIRE_SCHEDULE_ID,
} from './jobs/job-names';
import { REWARDS_OUTBOX_ROUTES } from './jobs/rewards-events.handler';
import { RewardsEventsProcessor } from './jobs/rewards-events.processor';
import { VouchersExpireProcessor } from './jobs/vouchers-expire.processor';
import { rewardsConfigProvider } from './rewards.config';
import { AdminVouchersService } from './services/admin-vouchers.service';
import { PrismaRewardsRepository } from './services/prisma-rewards.repository';
import { RedemptionService } from './services/redemption.service';
import { RewardsCatalogueService } from './services/rewards-catalogue.service';
import { RewardsRepository } from './services/rewards.repository';
import { ValidatorDevicesService } from './services/validator-devices.service';
import { ValidatorService } from './services/validator.service';
import { VoucherService } from './services/voucher.service';

/**
 * Rewards: reward catalogue (+ /admin CRUD), redemptions (points spent through the club
 * ledger), vouchers with 2-minute activation codes, cashier validator devices and API, the
 * minute `vouchers-expire` sweep and the `rewards-events` outbox consumer.
 *
 * Provides VOUCHER_ISSUER_PORT (VoucherService) for promos (coupons, tickets) and admin.
 * Depends on club (CLUB_LEDGER_PORT), content (CONTENT_PORT), parking (PARKING_PORT).
 * Must not depend on promos.
 */
@Module({
  imports: [
    ClubModule,
    ContentModule,
    ParkingModule,
    QueueModule.registerQueue(QUEUES.vouchersExpire, QUEUES.rewardsEvents),
  ],
  controllers: [
    RewardsController,
    VouchersController,
    ValidatorController,
    AdminRewardsController,
    AdminValidatorDevicesController,
    AdminVouchersController,
  ],
  providers: [
    rewardsConfigProvider,
    { provide: RewardsRepository, useClass: PrismaRewardsRepository },
    VoucherService,
    RedemptionService,
    RewardsCatalogueService,
    ValidatorService,
    ValidatorDevicesService,
    AdminVouchersService,
    ValidatorGuard,
    VouchersExpireProcessor,
    RewardsEventsProcessor,
    { provide: VOUCHER_ISSUER_PORT, useExisting: VoucherService },
  ],
  exports: [VOUCHER_ISSUER_PORT, VoucherService],
})
export class RewardsModule implements OnModuleInit {
  constructor(
    private readonly router: OutboxRouter,
    private readonly schedules: WorkerSchedules,
  ) {}

  onModuleInit(): void {
    this.router.addRoutes(REWARDS_OUTBOX_ROUTES);
    this.schedules.register({
      id: VOUCHERS_EXPIRE_SCHEDULE_ID,
      queue: QUEUES.vouchersExpire,
      jobName: REWARDS_JOBS.expireVouchers,
      every: VOUCHERS_EXPIRE_EVERY_MS,
    });
  }
}
