import { ParseUUIDPipe } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';

/** `@Param('id', uuidParam())`: a non-UUID answers 400 PC_COMMON_VALIDATION like the body pipe. */
export function uuidParam(name = 'id'): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new DomainError(CommonErrors.PC_COMMON_VALIDATION, `${name} must be a UUID`, {
        details: [{ path: name, messages: [`${name} must be a UUID`] }],
      }),
  });
}

/** ISO strings validated by class-validator, converted at the controller edge. */
export function toDate(value: string): Date {
  return new Date(value);
}
