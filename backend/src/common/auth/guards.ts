import { type CanActivate, type ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import { AdminAccessGate } from './admin-access';
import { OPTIONAL_AUTH_METADATA, PUBLIC_METADATA, ROLES_METADATA } from './auth.constants';
import type { AuthenticatedRequest, PrincipalType } from './auth.types';
import { TokenService } from './token.service';

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

export function isOptionalAuthRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(OPTIONAL_AUTH_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

export function isPublicRoute(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(PUBLIC_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

/**
 * Verifies the Bearer access token and attaches `request.user`.
 * Subclasses pin the expected principal type; a token of the other type yields 403.
 */
@Injectable()
export abstract class AccessTokenGuard implements CanActivate {
  protected abstract readonly expectedType: PrincipalType;

  constructor(
    protected readonly tokens: TokenService,
    protected readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    return this.authenticate(context);
  }

  /** Synchronous token check: throws 401/403 DomainErrors, attaches `request.user`. */
  protected authenticate(context: ExecutionContext): boolean {
    if (isPublicRoute(this.reflector, context)) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      // @OptionalAuth(): anonymous callers pass with request.user unset. A token that is sent
      // is still verified, so an expired token yields 401 and the app refreshes it.
      if (isOptionalAuthRoute(this.reflector, context)) {
        return true;
      }
      throw new DomainError(CommonErrors.PC_AUTH_UNAUTHORIZED, 'Bearer access token is required');
    }
    const claims = this.tokens.verifyAccessToken(token);
    if (claims.typ !== this.expectedType) {
      throw new DomainError(
        CommonErrors.PC_AUTH_FORBIDDEN,
        `This endpoint requires a ${this.expectedType} access token`,
      );
    }
    request.user = this.tokens.toAuthenticatedUser(claims);
    return true;
  }
}

/** Member (app user) endpoints. */
@Injectable()
export class MemberGuard extends AccessTokenGuard {
  protected readonly expectedType: PrincipalType = 'member';
}

/**
 * Back-office endpoints under /admin/*. Combine with RolesGuard / @Auth('admin', ...roles).
 * After the token check it asks AdminAccessGate whether the account is still active and still
 * has the role from the token (identity registers the lookup; cached for 30 s).
 */
@Injectable()
export class AdminGuard extends AccessTokenGuard {
  protected readonly expectedType: PrincipalType = 'admin';

  constructor(
    tokens: TokenService,
    reflector: Reflector,
    @Optional() private readonly access?: AdminAccessGate,
  ) {
    super(tokens, reflector);
  }

  override canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    // Token errors are thrown synchronously, before any lookup.
    this.authenticate(context);
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user || !this.access?.active) {
      return true;
    }
    return this.access.assertActive(user).then(() => true);
  }
}

/**
 * Checks `@Roles()` / `@Auth('admin', ...roles)` metadata against `request.user.roles`.
 * The `owner` role passes every check. No metadata means no restriction.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[] | undefined>(ROLES_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) {
      throw new DomainError(CommonErrors.PC_AUTH_UNAUTHORIZED, 'Authentication is required');
    }
    if (user.type === 'admin' && user.roles.includes('owner')) {
      return true;
    }
    if (required.some((role) => user.roles.includes(role))) {
      return true;
    }
    throw new DomainError(CommonErrors.PC_AUTH_FORBIDDEN, 'Insufficient role', {
      details: { required },
    });
  }
}
