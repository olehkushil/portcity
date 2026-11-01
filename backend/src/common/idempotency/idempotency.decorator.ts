import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { ApiProblemResponses } from '../errors/api-problem.decorator';
import { IdempotencyInterceptor } from './idempotency.interceptor';

export const IDEMPOTENT_METADATA = 'portcity:idempotent';

/**
 * Marks a mutation endpoint as requiring the `Idempotency-Key` header (brief section 3):
 * receipts submission, redemptions, parking payments, and every other endpoint with a
 * financial or points effect.
 */
export function Idempotent(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, true),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'Unique key per logical operation (UUID recommended). Replays return the stored response; the same key with a different body or on another resource (e.g. another voucher id) yields 409.',
    }),
    ApiProblemResponses(400, 409),
  );
}
