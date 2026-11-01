import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_CONFIG } from './config.tokens';
import { getValidatedEnv, validateEnv } from './env.schema';

/**
 * Loads `.env.local` / `.env` (except in tests), validates process.env with the zod schema
 * and exposes the typed result under the APP_CONFIG token.
 *
 * Consumers inject APP_CONFIG (not ConfigService) so tests can override the whole
 * configuration object with `overrideProvider(APP_CONFIG)`.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      envFilePath: ['.env.local', '.env'],
      expandVariables: false,
    }),
  ],
  providers: [{ provide: APP_CONFIG, useFactory: () => getValidatedEnv() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
