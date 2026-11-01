import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureHttpApp } from './app.setup';
import { API_PREFIX } from './common/app-info';
import { APP_CONFIG, type AppConfig } from './common/config';
import { buildOpenApiDocument, setupOpenApi } from './common/openapi';

/** API entrypoint: HTTP on PORT, prefix /api/v1, Swagger at /docs, graceful shutdown. */
async function bootstrap(): Promise<void> {
  // rawBody: provider webhooks (payments, parking) verify signatures over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<AppConfig>(APP_CONFIG);
  configureHttpApp(app, config);

  if (config.DOCS_ENABLED) {
    setupOpenApi(app, buildOpenApiDocument(app));
  }

  await app.listen(config.PORT, config.HOST);
  logger.log(
    `API listening on http://${config.HOST}:${config.PORT}/${API_PREFIX} (env ${config.NODE_ENV}, docs ${
      config.DOCS_ENABLED ? '/docs' : 'disabled'
    }, queues ${config.QUEUE_DRIVER})`,
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('API failed to start', error);
  process.exit(1);
});
