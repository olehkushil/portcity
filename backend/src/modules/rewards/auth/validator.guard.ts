import type { IncomingHttpHeaders } from 'node:http';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  type ValidatorAuthOptions,
  type ValidatorPrincipal,
  ValidatorService,
} from '../services/validator.service';

export const VALIDATOR_AUTH_METADATA = 'portcity:rewards:validator-auth';

export interface ValidatorRequest {
  headers: IncomingHttpHeaders;
  validator?: ValidatorPrincipal;
  ip?: string;
}

/**
 * Validator device authentication (brief section 8): `X-Validator-Key` identifies the device,
 * a shift token or the PIN proves the cashier. Attaches `request.validator`.
 */
@Injectable()
export class ValidatorGuard implements CanActivate {
  constructor(
    private readonly validators: ValidatorService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<ValidatorAuthOptions | undefined>(
      VALIDATOR_AUTH_METADATA,
      [context.getHandler(), context.getClass()],
    ) ?? { requireShift: true };
    const request = context.switchToHttp().getRequest<ValidatorRequest>();
    request.validator = await this.validators.authenticate(request.headers, options);
    return true;
  }
}
