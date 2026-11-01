import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { buildBullQueueOptions } from './bull-options';
import { QueueRegistry } from './queue-registry.service';
import { WorkerSchedules } from './worker-schedules.service';

/**
 * Carrier for the providers created by `QueueModule.registerQueue()`.
 * It is a separate class on purpose: a dynamic module built from `QueueModule` itself would
 * instantiate a second copy of QueueRegistry/WorkerSchedules per feature module.
 */
@Module({})
export class QueueFeatureModule {}

/**
 * Queue infrastructure.
 * - `QueueModule` (imported once by AppModule, global) configures BullMQ with manual processor
 *   registration: processors only start when the worker entrypoint calls `BullRegistrar.register()`.
 * - `QueueModule.registerQueue(...names)` is imported by the module that owns a queue; it provides
 *   the queue under the standard token so `@InjectQueue(name)` works, and honours QUEUE_DRIVER=memory.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildBullQueueOptions(config),
      extraOptions: { manualRegistration: true },
    }),
  ],
  providers: [QueueRegistry, WorkerSchedules],
  exports: [QueueRegistry, WorkerSchedules],
})
export class QueueModule {
  static registerQueue(...names: string[]): DynamicModule {
    const providers: Provider[] = names.map((name) => ({
      provide: getQueueToken(name),
      inject: [QueueRegistry],
      useFactory: (registry: QueueRegistry) => registry.create(name),
    }));
    return {
      module: QueueFeatureModule,
      providers,
      exports: providers,
    };
  }
}
