import 'reflect-metadata';
import './openapi-env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module';
import { configureHttpApp } from '../app.setup';
import { APP_CONFIG, type AppConfig } from '../common/config';
import { buildOpenApiDocument } from '../common/openapi';

/** `npm run openapi [target]` writes docs/openapi.json (brief section 1). */
async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  const config = app.get<AppConfig>(APP_CONFIG);
  configureHttpApp(app, config);
  await app.init();

  const document = buildOpenApiDocument(app);
  const target = resolve(process.cwd(), process.argv[2] ?? 'docs/openapi.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();
  console.log(`OpenAPI written to ${target} (${Object.keys(document.paths).length} paths)`);
}

main().catch((error: unknown) => {
  console.error('OpenAPI generation failed', error);
  process.exit(1);
});
