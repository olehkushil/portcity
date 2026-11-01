import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validateEnv } from '../config/env.schema';
import type { AdminAccess } from '../contracts/identity';
import { DomainError } from '../errors/domain-error';
import { FakeClock } from '../time/clock';
import { AdminAccessGate } from './admin-access';
import type { AuthenticatedRequest, AuthenticatedUser } from './auth.types';
import { AdminGuard } from './guards';
import { TokenService } from './token.service';

function admin(roles: string[], id = 'admin-1'): AuthenticatedUser {
  return { id, type: 'admin', roles, tokenId: 't', tokenExpiresAt: new Date() };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (DomainError.is(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('AdminAccessGate', () => {
  const config = validateEnv({ NODE_ENV: 'test', ADMIN_ACCESS_CACHE_SECONDS: '30' });

  function setup(store: Map<string, AdminAccess>): {
    gate: AdminAccessGate;
    clock: FakeClock;
    calls: string[];
  } {
    const clock = new FakeClock();
    const gate = new AdminAccessGate(config, clock);
    const calls: string[] = [];
    gate.useResolver(async (id) => {
      calls.push(id);
      return store.get(id) ?? null;
    });
    return { gate, clock, calls };
  }

  it('lets an active admin with the role from the token through', async () => {
    const { gate } = setup(new Map([['admin-1', { active: true, role: 'moderator' }]]));
    await expect(gate.assertActive(admin(['moderator']))).resolves.toBeUndefined();
  });

  it('refuses deactivated and unknown admins with 403 PC_ADMIN_INACTIVE', async () => {
    const { gate } = setup(new Map([['admin-1', { active: false, role: 'owner' }]]));
    expect(await codeOf(gate.assertActive(admin(['owner'])))).toBe('PC_ADMIN_INACTIVE');
    expect(await codeOf(gate.assertActive(admin(['owner'], 'ghost')))).toBe('PC_ADMIN_INACTIVE');
  });

  it('refuses a token whose role no longer matches the account', async () => {
    const { gate } = setup(new Map([['admin-1', { active: true, role: 'support' }]]));
    expect(await codeOf(gate.assertActive(admin(['manager'])))).toBe('PC_AUTH_TOKEN_INVALID');
  });

  it('caches answers for ADMIN_ACCESS_CACHE_SECONDS and honours invalidate()', async () => {
    const store = new Map<string, AdminAccess>([['admin-1', { active: true, role: 'owner' }]]);
    const { gate, clock, calls } = setup(store);
    await gate.assertActive(admin(['owner']));
    store.set('admin-1', { active: false, role: 'owner' });
    await gate.assertActive(admin(['owner']));
    expect(calls).toHaveLength(1);

    clock.advanceSeconds(31);
    expect(await codeOf(gate.assertActive(admin(['owner'])))).toBe('PC_ADMIN_INACTIVE');
    expect(calls).toHaveLength(2);

    store.set('admin-1', { active: true, role: 'owner' });
    gate.invalidate('admin-1');
    await expect(gate.assertActive(admin(['owner']))).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it('is a no-op without a resolver, when disabled and for member principals', async () => {
    const clock = new FakeClock();
    const bare = new AdminAccessGate(config, clock);
    expect(bare.active).toBe(false);
    await expect(bare.assertActive(admin(['owner']))).resolves.toBeUndefined();

    const { gate, calls } = setup(new Map());
    gate.setEnabled(false);
    await expect(gate.assertActive(admin(['owner']))).resolves.toBeUndefined();
    gate.setEnabled(true);
    await expect(
      gate.assertActive({ ...admin([]), type: 'member', roles: [] }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('answers 503 when the lookup itself fails', async () => {
    const gate = new AdminAccessGate(config, new FakeClock());
    gate.useResolver(async () => {
      throw new Error('database down');
    });
    expect(await codeOf(gate.assertActive(admin(['owner'])))).toBe('PC_COMMON_SERVICE_UNAVAILABLE');
  });
});

describe('AdminGuard with AdminAccessGate', () => {
  const config = validateEnv({ NODE_ENV: 'test', JWT_SECRET: 'unit-test-secret-0123456789abcdef' });
  const clock = new FakeClock();
  const tokens = new TokenService(config, clock);
  const reflector = new Reflector();

  function contextWith(token: string): {
    context: ExecutionContext;
    request: AuthenticatedRequest;
  } {
    const request = { headers: { authorization: `Bearer ${token}` } } as AuthenticatedRequest;
    const handler = (): void => undefined;
    class Host {}
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => Host,
      getType: () => 'http',
    } as unknown as ExecutionContext;
    return { context, request };
  }

  it('rejects the token of a deactivated admin after the signature check', async () => {
    const gate = new AdminAccessGate(config, clock);
    gate.useResolver(async () => ({ active: false, role: 'owner' }));
    const guard = new AdminGuard(tokens, reflector, gate);
    const token = tokens.signAccessToken({ sub: 'admin-9', type: 'admin', roles: ['owner'] }).token;
    const result = guard.canActivate(contextWith(token).context);
    expect(result).toBeInstanceOf(Promise);
    expect(await codeOf(result as Promise<boolean>)).toBe('PC_ADMIN_INACTIVE');
  });

  it('stays synchronous when no check is active', () => {
    const guard = new AdminGuard(tokens, reflector, new AdminAccessGate(config, clock));
    const token = tokens.signAccessToken({ sub: 'admin-9', type: 'admin', roles: ['owner'] }).token;
    const { context, request } = contextWith(token);
    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toMatchObject({ id: 'admin-9', type: 'admin' });
  });
});
