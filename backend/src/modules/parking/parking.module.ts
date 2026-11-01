import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { IDENTITY_EVENTS, PAYMENT_EVENTS } from '../../common/contracts/events';
import { PARKING_PORT } from '../../common/contracts/parking';
import { OutboxRouter } from '../../common/outbox/outbox-router';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { PaymentsModule } from '../payments/payments.module';
import { AdminParkingController } from './controllers/admin-parking.controller';
import { ParkingInfoController } from './controllers/parking-info.controller';
import { ParkingSessionsController } from './controllers/parking-sessions.controller';
import { ParkingTariffController } from './controllers/parking-tariff.controller';
import { ParkingVehiclesController } from './controllers/parking-vehicles.controller';
import { ParkingWebhooksController } from './controllers/parking-webhooks.controller';
import {
  PARKING_JOBS,
  PARKING_PAYMENTS_SWEEP_EVERY_MS,
  PARKING_PAYMENTS_SWEEP_SCHEDULE_ID,
  PARKING_SYNC_SCHEDULE_ID,
} from './jobs/job-names';
import { ParkingEventsProcessor } from './jobs/parking-events.processor';
import { ParkingSyncProcessor } from './jobs/parking-sync.processor';
import { PARKING_CONFIG, type ParkingConfig, parkingConfigProvider } from './parking.config';
import { parkingProviderFactory } from './provider/parking-provider.factory';
import { AirRaidService } from './services/air-raid.service';
import { InfoModeService } from './services/info-mode.service';
import { lookupLimiterFactory } from './services/lookup-limiter';
import { ParkingErasureService } from './services/parking-erasure.service';
import { ParkingPaymentsService } from './services/parking-payments.service';
import { ParkingService } from './services/parking.service';
import { SessionSyncService } from './services/session-sync.service';
import { SessionsService } from './services/sessions.service';
import { TariffService } from './services/tariff.service';
import { VehiclesService } from './services/vehicles.service';

/**
 * Parking: vehicles, sessions (operator-synced or info-mode timers), tariff calculator and the
 * admin tariff/session tools, provider port (emulator / vendor stub), queue `parking-sync`
 * (sync every 60 s, payments sweep every 5 min) and the consumer of `payment.succeeded` (long
 * retry policy) and `user.deleted` on `parking-events`.
 * Publishes the session lifecycle and reminder events (consumed by notifications).
 * Provides PARKING_PORT (ParkingService). Depends on payments (PAYMENTS_PORT).
 * Consumed by rewards, notifications, admin.
 */
@Module({
  imports: [PaymentsModule, QueueModule.registerQueue(QUEUES.parkingSync, QUEUES.parkingEvents)],
  controllers: [
    ParkingSessionsController,
    ParkingVehiclesController,
    ParkingTariffController,
    ParkingInfoController,
    ParkingWebhooksController,
    AdminParkingController,
  ],
  providers: [
    parkingConfigProvider,
    parkingProviderFactory,
    lookupLimiterFactory,
    TariffService,
    AirRaidService,
    VehiclesService,
    SessionSyncService,
    SessionsService,
    InfoModeService,
    ParkingPaymentsService,
    ParkingErasureService,
    ParkingService,
    ParkingSyncProcessor,
    ParkingEventsProcessor,
    { provide: PARKING_PORT, useExisting: ParkingService },
  ],
  exports: [PARKING_PORT, ParkingService, TariffService],
})
export class ParkingModule implements OnModuleInit {
  constructor(
    private readonly router: OutboxRouter,
    private readonly schedules: WorkerSchedules,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  onModuleInit(): void {
    this.router.addRoutes({
      [PAYMENT_EVENTS.succeeded]: QUEUES.parkingEvents,
      // Account erased by identity: drop the plates parking holds for it.
      [IDENTITY_EVENTS.deleted]: QUEUES.parkingEvents,
    });
    this.schedules.register({
      id: PARKING_SYNC_SCHEDULE_ID,
      queue: QUEUES.parkingSync,
      jobName: PARKING_JOBS.sync,
      every: this.config.PARKING_SYNC_EVERY_MS,
    });
    // Safety net for payment.succeeded: paid app payments not applied or not registered yet.
    this.schedules.register({
      id: PARKING_PAYMENTS_SWEEP_SCHEDULE_ID,
      queue: QUEUES.parkingSync,
      jobName: PARKING_JOBS.paymentsSweep,
      every: PARKING_PAYMENTS_SWEEP_EVERY_MS,
    });
  }
}
