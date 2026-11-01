import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { QUEUES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { WorkerSchedules } from '../queue/worker-schedules.service';
import { AUDIT_ONLY_OUTBOX_EVENTS } from './audit-only-events';
import { OutboxDispatchProcessor } from './outbox-dispatch.processor';
import { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxRouter } from './outbox-router';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  imports: [QueueModule.registerQueue(QUEUES.outboxDispatch)],
  providers: [OutboxService, OutboxRouter, OutboxDispatcher, OutboxDispatchProcessor],
  exports: [OutboxService, OutboxRouter, OutboxDispatcher],
})
export class OutboxModule implements OnModuleInit {
  constructor(
    private readonly schedules: WorkerSchedules,
    private readonly router: OutboxRouter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    for (const [type, reason] of Object.entries(AUDIT_ONLY_OUTBOX_EVENTS)) {
      if (reason) {
        this.router.ignore(type, reason);
      }
    }
    this.schedules.register({
      id: 'outbox-dispatch',
      queue: QUEUES.outboxDispatch,
      jobName: 'tick',
      every: this.config.OUTBOX_DISPATCH_EVERY_MS,
      opts: { removeOnComplete: 20, removeOnFail: 100 },
    });
  }
}
