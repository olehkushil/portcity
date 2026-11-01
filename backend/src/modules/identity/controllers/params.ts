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

/** Express `req.ip` may be undefined behind unusual proxies; the services accept null. */
export function clientIp(ip: string | undefined): string | null {
  return ip && ip.trim() !== '' ? ip : null;
}
