import { Module, type OnModuleInit } from '@nestjs/common';
import { REWARD_EVENTS } from '../../common/contracts/events';
import { PROMOS_PORT } from '../../common/contracts/promos';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { ContentModule } from '../content/content.module';
import { RewardsModule } from '../rewards/rewards.module';
import { AdminCouponTemplatesController } from './controllers/admin-coupon-templates.controller';
import { AdminEventsController } from './controllers/admin-events.controller';
import { AdminPromosController } from './controllers/admin-promos.controller';
import { EventsController } from './controllers/events.controller';
import { PromosController } from './controllers/promos.controller';
import { PROMOS_JOBS } from './jobs/promos-events.handlers';
import { PromosEventsProcessor } from './jobs/promos-events.processor';
import { EventsAdminService } from './services/events-admin.service';
import { EventsService } from './services/events.service';
import { PromosAdminService } from './services/promos-admin.service';
import { PromosPortService } from './services/promos-port.service';
import { PromosPresenter } from './services/promos-presenter.service';
import { PromosService } from './services/promos.service';

/** How often published events whose end has passed are marked finished. */
export const FINISH_EVENTS_EVERY_MS = 3_600_000;

/**
 * Promos: promos, coupon templates, events, registrations and tickets (+ /admin CRUD).
 * Provides PROMOS_PORT. Depends on rewards (VOUCHER_ISSUER_PORT) and content (CONTENT_PORT);
 * consumed by admin and notifications. Owns the queue promos-events (outbox consumer for
 * voucher.redeemed / voucher.cancelled plus the hourly finish-events schedule).
 */
@Module({
  imports: [RewardsModule, ContentModule, QueueModule.registerQueue(QUEUES.promosEvents)],
  controllers: [
    PromosController,
    EventsController,
    AdminPromosController,
    AdminCouponTemplatesController,
    AdminEventsController,
  ],
  providers: [
    PromosPresenter,
    PromosService,
    EventsService,
    PromosAdminService,
    EventsAdminService,
    PromosPortService,
    PromosEventsProcessor,
    { provide: PROMOS_PORT, useExisting: PromosPortService },
  ],
  exports: [PROMOS_PORT, PromosService, EventsService],
})
export class PromosModule implements OnModuleInit {
  constructor(
    private readonly router: OutboxRouter,
    private readonly schedules: WorkerSchedules,
  ) {}

  onModuleInit(): void {
    this.router.addRoutes({
      [REWARD_EVENTS.voucherRedeemed]: QUEUES.promosEvents,
      [REWARD_EVENTS.voucherCancelled]: QUEUES.promosEvents,
    });
    this.schedules.register({
      id: 'promos-finish-events',
      queue: QUEUES.promosEvents,
      jobName: PROMOS_JOBS.finishEvents,
      every: FINISH_EVENTS_EVERY_MS,
    });
  }
}
