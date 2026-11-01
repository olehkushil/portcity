import { Global, Module } from '@nestjs/common';
import { envSectionProvider } from '../config/env-section';
import { IDEMPOTENCY_CONFIG, idempotencyEnvSchema } from './idempotency.config';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

@Global()
@Module({
  providers: [
    envSectionProvider(IDEMPOTENCY_CONFIG, idempotencyEnvSchema, 'idempotency'),
    IdempotencyService,
    IdempotencyInterceptor,
  ],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class IdempotencyModule {}
