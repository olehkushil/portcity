import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validateEnv } from '../config/env.schema';
import { DomainError } from '../errors/domain-error';
import { FakeClock } from '../time/clock';
import { OPTIONAL_AUTH_METADATA, PUBLIC_METADATA } from './auth.constants';
import { OptionalAuth } from './auth.decorators';
import type { AuthenticatedRequest } from './auth.types';
import { MemberGuard, isOptionalAuthRoute } from './guards';
import { TokenService } from './token.service';

function contextFor(
  headers: Record<string, string>,
  handlerMetadata: Record<string, unknown>,
): { context: ExecutionContext; request: AuthenticatedRequest } {
  const handler = (): void => undefined;
  class Host {}
  for (const [key, value] of Object.entries(handlerMetadata)) {
    Reflect.defineMetadata(key, value, handler);
  }
  const request = { headers } as unknown as AuthenticatedRequest;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => Host,
    getType: () => 'http',
  } as unknown as ExecutionContext;
  return { context, request };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (DomainError.is(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('OptionalAuth', () => {
  const config = validateEnv({ NODE_ENV: 'test', JWT_SECRET: 'unit-test-secret-0123456789abcdef' });
  const tokens = new TokenService(config, new FakeClock());
  const reflector = new Reflector();
  const guard = new MemberGuard(tokens, reflector);
  const memberToken = tokens.signAccessToken({
    sub: 'user-1',
    type: 'member',
    deviceId: 'd1',
  }).token;
  const adminToken = tokens.signAccessToken({
    sub: 'admin-1',
    type: 'admin',
    roles: ['owner'],
  }).token;
  const optional = { [OPTIONAL_AUTH_METADATA]: true };

  it('sets the metadata read by the guard', () => {
    class Controller {
      @OptionalAuth()
      handler(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Controller.prototype, 'handler');
    expect(Reflect.getMetadata(OPTIONAL_AUTH_METADATA, descriptor?.value as object)).toBe(true);
  });

  it('lets an anonymous caller through without a user', () => {
    const { context, request } = contextFor({}, optional);
    expect(isOptionalAuthRoute(reflector, context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('attaches the member when a valid member token is sent', () => {
    const { context, request } = contextFor({ authorization: `Bearer ${memberToken}` }, optional);
    expect(guard.canActivate(context)).toBe(true);
    expect(request.user?.id).toBe('user-1');
  });

  it('still rejects an invalid token with 401 and an admin token with 403', () => {
    expect(
      codeOf(() =>
        guard.canActivate(contextFor({ authorization: 'Bearer nope' }, optional).context),
      ),
    ).toBe('PC_AUTH_TOKEN_INVALID');
    expect(
      codeOf(() =>
        guard.canActivate(contextFor({ authorization: `Bearer ${adminToken}` }, optional).context),
      ),
    ).toBe('PC_AUTH_FORBIDDEN');
  });

  it('does not change routes without the decorator', () => {
    expect(codeOf(() => guard.canActivate(contextFor({}, {}).context))).toBe(
      'PC_AUTH_UNAUTHORIZED',
    );
    expect(guard.canActivate(contextFor({}, { [PUBLIC_METADATA]: true }).context)).toBe(true);
  });
});
