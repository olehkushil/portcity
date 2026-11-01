import {
  type ExecutionContext,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';
import {
  VALIDATOR_KEY_SECURITY,
  VALIDATOR_SHIFT_SECURITY,
} from '../../../common/auth/auth.constants';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import type { ValidatorAuthOptions } from '../services/validator.service';
import { VALIDATOR_AUTH_METADATA, ValidatorGuard, type ValidatorRequest } from './validator.guard';

export interface ValidatorAuthDecoratorOptions {
  /** Default true: the request must carry a shift token or the PIN besides the device key. */
  shift?: boolean;
}

/**
 * Protects a validator endpoint: `@ValidatorAuth()` requires the device key and the shift
 * token, `@ValidatorAuth({ shift: false })` requires only the device key (opening a shift with
 * the PIN in the body, the only place the PIN is accepted).
 */
export function ValidatorAuth(
  options: ValidatorAuthDecoratorOptions = {},
): MethodDecorator & ClassDecorator {
  const metadata: ValidatorAuthOptions = { requireShift: options.shift ?? true };
  // OpenAPI security: the device key alone opens a shift; every other route needs the key AND
  // the shift token (one requirement object with both schemes).
  const security = metadata.requireShift
    ? [ApiSecurity({ [VALIDATOR_KEY_SECURITY]: [], [VALIDATOR_SHIFT_SECURITY]: [] })]
    : [ApiSecurity(VALIDATOR_KEY_SECURITY)];
  const decorators = [
    SetMetadata(VALIDATOR_AUTH_METADATA, metadata),
    UseGuards(ValidatorGuard),
    ...security,
    ApiProblemResponses(401, 403),
  ];
  return applyDecorators(...decorators);
}

/** Injects the authenticated validator device (`ValidatorPrincipal`). */
export const CurrentValidator = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    return context.switchToHttp().getRequest<ValidatorRequest>().validator;
  },
);
