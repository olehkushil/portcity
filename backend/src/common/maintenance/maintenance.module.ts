import { Module, type OnModuleInit } from '@nestjs/common';
import { QUEUES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { WorkerSchedules } from '../queue/worker-schedules.service';
import { MAINTENANCE_JOBS } from './maintenance.jobs';
import { MaintenanceProcessor } from './maintenance.processor';

/** Housekeeping jobs owned by the common layer (idempotency keys, outbox retention). */
@Module({
  imports: [QueueModule.registerQueue(QUEUES.maintenance)],
  providers: [MaintenanceProcessor],
})
export class MaintenanceModule implements OnModuleInit {
  constructor(private readonly schedules: WorkerSchedules) {}

  onModuleInit(): void {
    this.schedules.register({
      id: 'maintenance-idempotency-purge',
      queue: QUEUES.maintenance,
      jobName: MAINTENANCE_JOBS.idempotencyPurge,
      every: 3_600_000,
    });
    this.schedules.register({
      id: 'maintenance-outbox-purge',
      queue: QUEUES.maintenance,
      jobName: MAINTENANCE_JOBS.outboxPurge,
      pattern: '0 4 * * *',
    });
  }
}
