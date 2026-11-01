import {
  type ExecutionContext,
  SetMetadata,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtension } from '@nestjs/swagger';
import { ApiProblemResponses } from '../errors/api-problem.decorator';
import {
  AUTH_KIND_EXTENSION,
  AUTH_KIND_METADATA,
  BEARER_SECURITY,
  OPTIONAL_AUTH_METADATA,
  PUBLIC_METADATA,
  ROLES_EXTENSION,
  ROLES_METADATA,
} from './auth.constants';
import type { AuthenticatedRequest, AuthenticatedUser, PrincipalType } from './auth.types';
import { AdminGuard, MemberGuard, RolesGuard } from './guards';

/**
 * Protects a controller or handler.
 *   @Auth('member')                       member access token required
 *   @Auth('admin', 'manager', 'owner')    admin token with one of the roles
 * Adds Swagger bearer security and 401/403 problem responses.
 */
export function Auth(kind: PrincipalType, ...roles: string[]): MethodDecorator & ClassDecorator {
  const guard = kind === 'admin' ? AdminGuard : MemberGuard;
  return applyDecorators(
    SetMetadata(AUTH_KIND_METADATA, kind),
    SetMetadata(ROLES_METADATA, roles),
    UseGuards(guard, RolesGuard),
    ApiBearerAuth(BEARER_SECURITY),
    ApiProblemResponses(401, 403),
    // OpenAPI vendor extensions read by docs/API.md (src/scripts/api-md.ts). Handler-level values
    // win over controller-level ones, like the guard metadata.
    ApiExtension(AUTH_KIND_EXTENSION, kind),
    ApiExtension(ROLES_EXTENSION, roles),
  );
}

/** Opts a handler out of a controller-level `@Auth()`. */
export const Public = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(PUBLIC_METADATA, true),
    ApiExtension(AUTH_KIND_EXTENSION, 'public'),
    ApiExtension(ROLES_EXTENSION, []),
  );

/**
 * Guest-readable member endpoint: works without a token (request.user stays undefined, so
 * `@CurrentUser()` returns undefined) and attaches the member when a valid member token is sent.
 * Use on a handler inside an `@Auth('member')` controller or on its own; an invalid or expired
 * token still yields 401 and an admin token yields 403.
 */
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(OPTIONAL_AUTH_METADATA, true),
    UseGuards(MemberGuard),
    ApiBearerAuth(BEARER_SECURITY),
    ApiExtension(AUTH_KIND_EXTENSION, 'optional'),
    ApiExtension(ROLES_EXTENSION, []),
  );

/** Role restriction without re-declaring the guard (e.g. on a handler inside an @Auth('admin') controller). */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(ROLES_METADATA, roles), ApiExtension(ROLES_EXTENSION, roles));

/**
 * Injects the authenticated principal: `@CurrentUser() user: AuthenticatedUser`
 * or a single field: `@CurrentUser('id') userId: string`.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) {
      return undefined;
    }
    return field ? user[field] : user;
  },
);
