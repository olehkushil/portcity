import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validateEnv } from '../config/env.schema';
import { DomainError } from '../errors/domain-error';
import { FakeClock } from '../time/clock';
import { PUBLIC_METADATA, ROLES_METADATA } from './auth.constants';
import type { AuthenticatedRequest } from './auth.types';
import { AdminGuard, MemberGuard, RolesGuard, extractBearerToken } from './guards';
import { TokenService } from './token.service';

function contextFor(
  request: Partial<AuthenticatedRequest>,
  handlerMetadata: Record<string, unknown> = {},
  classMetadata: Record<string, unknown> = {},
): { context: ExecutionContext; request: AuthenticatedRequest } {
  const handler = (): void => undefined;
  class Host {}
  for (const [key, value] of Object.entries(handlerMetadata)) {
    Reflect.defineMetadata(key, value, handler);
  }
  for (const [key, value] of Object.entries(classMetadata)) {
    Reflect.defineMetadata(key, value, Host);
  }
  const fullRequest = { headers: {}, ...request };
  const context = {
    switchToHttp: () => ({
      getRequest: () => fullRequest,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => Host,
    getType: () => 'http',
  } as unknown as ExecutionContext;
  return { context, request: fullRequest };
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

describe('auth guards', () => {
  const config = validateEnv({ NODE_ENV: 'test', JWT_SECRET: 'unit-test-secret-0123456789abcdef' });
  const clock = new FakeClock();
  const tokens = new TokenService(config, clock);
  const reflector = new Reflector();
  const memberGuard = new MemberGuard(tokens, reflector);
  const adminGuard = new AdminGuard(tokens, reflector);
  const rolesGuard = new RolesGuard(reflector);

  const memberToken = tokens.signAccessToken({
    sub: 'user-1',
    type: 'member',
    deviceId: 'd1',
  }).token;
  const adminToken = tokens.signAccessToken({
    sub: 'admin-1',
    type: 'admin',
    roles: ['moderator'],
  }).token;

  it('extracts bearer tokens', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer   abc')).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('MemberGuard attaches the user for a valid member token', () => {
    const { context, request } = contextFor({
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(memberGuard.canActivate(context)).toBe(true);
    expect(request.user).toMatchObject({ id: 'user-1', type: 'member', deviceId: 'd1' });
  });

  it('MemberGuard rejects missing, invalid and expired tokens with 401 codes', () => {
    expect(codeOf(() => memberGuard.canActivate(contextFor({}).context))).toBe(
      'PC_AUTH_UNAUTHORIZED',
    );
    expect(
      codeOf(() =>
        memberGuard.canActivate(contextFor({ headers: { authorization: 'Bearer nope' } }).context),
      ),
    ).toBe('PC_AUTH_TOKEN_INVALID');

    const shortLived = tokens.signAccessToken({ sub: 'u', type: 'member', ttlSeconds: 60 }).token;
    clock.advanceMinutes(2);
    expect(
      codeOf(() =>
        memberGuard.canActivate(
          contextFor({ headers: { authorization: `Bearer ${shortLived}` } }).context,
        ),
      ),
    ).toBe('PC_AUTH_TOKEN_EXPIRED');
    clock.advanceMinutes(-2);
  });

  it('rejects a token of the other principal type with 403', () => {
    expect(
      codeOf(() =>
        memberGuard.canActivate(
          contextFor({ headers: { authorization: `Bearer ${adminToken}` } }).context,
        ),
      ),
    ).toBe('PC_AUTH_FORBIDDEN');
    expect(
      codeOf(() =>
        adminGuard.canActivate(
          contextFor({ headers: { authorization: `Bearer ${memberToken}` } }).context,
        ),
      ),
    ).toBe('PC_AUTH_FORBIDDEN');
    expect(
      adminGuard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${adminToken}` } }).context,
      ),
    ).toBe(true);
  });

  it('honours @Public() on the handler and on the class', () => {
    expect(memberGuard.canActivate(contextFor({}, { [PUBLIC_METADATA]: true }).context)).toBe(true);
    expect(memberGuard.canActivate(contextFor({}, {}, { [PUBLIC_METADATA]: true }).context)).toBe(
      true,
    );
  });

  it('RolesGuard enforces roles with owner bypass', () => {
    const noRoles = contextFor({
      user: { id: 'a', type: 'admin', roles: [], tokenId: 't', tokenExpiresAt: new Date() },
    });
    expect(rolesGuard.canActivate(noRoles.context)).toBe(true);

    const moderator = contextFor(
      {
        user: {
          id: 'a',
          type: 'admin',
          roles: ['moderator'],
          tokenId: 't',
          tokenExpiresAt: new Date(),
        },
      },
      { [ROLES_METADATA]: ['manager', 'moderator'] },
    );
    expect(rolesGuard.canActivate(moderator.context)).toBe(true);

    const support = contextFor(
      {
        user: {
          id: 'a',
          type: 'admin',
          roles: ['support'],
          tokenId: 't',
          tokenExpiresAt: new Date(),
        },
      },
      { [ROLES_METADATA]: ['manager'] },
    );
    expect(codeOf(() => rolesGuard.canActivate(support.context))).toBe('PC_AUTH_FORBIDDEN');

    const owner = contextFor(
      {
        user: {
          id: 'a',
          type: 'admin',
          roles: ['owner'],
          tokenId: 't',
          tokenExpiresAt: new Date(),
        },
      },
      { [ROLES_METADATA]: ['manager'] },
    );
    expect(rolesGuard.canActivate(owner.context)).toBe(true);

    const anonymous = contextFor({}, { [ROLES_METADATA]: ['manager'] });
    expect(codeOf(() => rolesGuard.canActivate(anonymous.context))).toBe('PC_AUTH_UNAUTHORIZED');
  });
});
