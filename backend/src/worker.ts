import 'reflect-metadata';
import './worker-mode';
import { BullRegistrar } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './common/config';
import { workerHttpAllowlist } from './common/health/worker-http';
import { QueueRegistry, WorkerSchedules } from './common/queue';

/**
 * Worker entrypoint (brief section 9): same AppModule, BullMQ processors started explicitly,
 * repeatable jobs upserted, HTTP limited to /health and /ready on WORKER_PORT.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<AppConfig>(APP_CONFIG);
  app.use(workerHttpAllowlist);
  app.enableShutdownHooks();
  await app.init();

  app.get(BullRegistrar).register();
  const applied = await app.get(WorkerSchedules).apply(app.get(QueueRegistry));

  await app.listen(config.WORKER_PORT, config.HOST);
  logger.log(
    `Worker started: processors registered, ${applied} schedules applied, probes on http://${config.HOST}:${config.WORKER_PORT}/health`,
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
