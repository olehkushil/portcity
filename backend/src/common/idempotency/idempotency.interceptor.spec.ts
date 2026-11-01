import 'reflect-metadata';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { DomainError } from '../errors/domain-error';
import {
  IDEMPOTENCY_STORE_RETRY_DELAYS_MS,
  IdempotencyInterceptor,
  buildIdempotencyScope,
  concreteRequestPath,
} from './idempotency.interceptor';
import type { BeginResult, IdempotencyService } from './idempotency.service';
import { computeRequestHash } from './request-hash';

const CLAIMED_AT = new Date('2026-01-15T10:00:00.000Z');

function createInterceptor(begin: BeginResult) {
  const service = {
    begin: jest.fn().mockResolvedValue(begin),
    complete: jest.fn().mockResolvedValue(true),
    abandon: jest.fn().mockResolvedValue(undefined),
  };
  const interceptor = new IdempotencyInterceptor(
    service as unknown as IdempotencyService,
    new Reflector(),
  );
  return { interceptor, service };
}

function createContext(options: {
  method?: string;
  key?: string;
  body?: unknown;
  user?: { id: string; type: 'member' | 'admin' };
  httpCode?: number;
  routePath?: string;
  originalUrl?: string;
}) {
  const handler = (): void => undefined;
  if (options.httpCode !== undefined) {
    Reflect.defineMetadata(HTTP_CODE_METADATA, options.httpCode, handler);
  }
  const headers: Record<string, string> = {};
  if (options.key !== undefined) {
    headers['idempotency-key'] = options.key;
  }
  const request = {
    method: options.method ?? 'POST',
    headers,
    body: options.body,
    ip: '10.0.0.1',
    route: { path: options.routePath ?? '/api/v1/receipts/qr' },
    ...(options.originalUrl !== undefined ? { originalUrl: options.originalUrl } : {}),
    user: options.user
      ? { ...options.user, roles: [], tokenId: 't', tokenExpiresAt: new Date() }
      : undefined,
  };
  const response = { setHeader: jest.fn(), status: jest.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => handler,
    getClass: () => class Host {},
    getType: () => 'http',
  } as unknown as ExecutionContext;
  return { context, request, response };
}

const next = (value: unknown): CallHandler => ({ handle: () => of(value) });

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

describe('IdempotencyInterceptor', () => {
  const validKey = '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11';
  const member = { id: 'u1', type: 'member' as const };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes GET requests through untouched', async () => {
    const { interceptor, service } = createInterceptor({ kind: 'proceed' });
    const { context } = createContext({ method: 'GET' });
    const result = await lastValueFrom(await interceptor.intercept(context, next({ ok: true })));
    expect(result).toEqual({ ok: true });
    expect(service.begin).not.toHaveBeenCalled();
  });

  it('requires a well-formed key on mutations', async () => {
    const { interceptor } = createInterceptor({ kind: 'proceed' });
    expect(await codeOf(interceptor.intercept(createContext({}).context, next({})))).toBe(
      'PC_COMMON_IDEMPOTENCY_KEY_REQUIRED',
    );
    expect(
      await codeOf(interceptor.intercept(createContext({ key: 'short' }).context, next({}))),
    ).toBe('PC_COMMON_IDEMPOTENCY_KEY_INVALID');
  });

  it('claims the key, runs the handler and stores the response with the handler status', async () => {
    const { interceptor, service } = createInterceptor({ kind: 'proceed', claimedAt: CLAIMED_AT });
    const body = { qrText: 'https://cabinet.tax.gov.ua/cashregs/check?fn=1&id=2' };
    const { context } = createContext({ key: validKey, body, user: member });

    const result = await lastValueFrom(await interceptor.intercept(context, next({ id: 'r1' })));
    expect(result).toEqual({ id: 'r1' });

    const expectedScope = 'member:u1|POST|/api/v1/receipts/qr';
    expect(service.begin).toHaveBeenCalledWith(
      expectedScope,
      validKey,
      computeRequestHash({ method: 'POST', path: '/api/v1/receipts/qr', body }),
    );
    expect(service.complete).toHaveBeenCalledWith(
      expectedScope,
      validKey,
      201,
      { id: 'r1' },
      CLAIMED_AT,
    );
  });

  it('uses @HttpCode metadata and anonymous scopes', async () => {
    const { interceptor, service } = createInterceptor({ kind: 'proceed' });
    const { context } = createContext({ key: validKey, httpCode: 200, method: 'PUT' });
    await lastValueFrom(await interceptor.intercept(context, next('done')));
    expect(service.complete).toHaveBeenCalledWith(
      'anon:10.0.0.1|PUT|/api/v1/receipts/qr',
      validKey,
      200,
      'done',
      undefined,
    );
  });

  it('hashes the concrete resource: the same key on another voucher is not the same request', async () => {
    // Regression: scope and hash used the route template, so the key used for voucher A
    // replayed A's response for voucher B and B was never cancelled.
    const routePath = '/api/v1/vouchers/:id/cancel';
    const first = createInterceptor({ kind: 'proceed' });
    await lastValueFrom(
      await first.interceptor.intercept(
        createContext({
          key: validKey,
          user: member,
          routePath,
          originalUrl: '/api/v1/vouchers/aaaa/cancel',
        }).context,
        next({ id: 'aaaa' }),
      ),
    );
    const second = createInterceptor({ kind: 'mismatch' });
    const code = await codeOf(
      second.interceptor.intercept(
        createContext({
          key: validKey,
          user: member,
          routePath,
          originalUrl: '/api/v1/vouchers/bbbb/cancel?reason=x',
        }).context,
        next({ id: 'bbbb' }),
      ),
    );
    expect(code).toBe('PC_COMMON_IDEMPOTENCY_MISMATCH');

    const [scopeA, , hashA] = first.service.begin.mock.calls[0] as [string, string, string];
    const [scopeB, , hashB] = second.service.begin.mock.calls[0] as [string, string, string];
    // Same key namespace (principal + route template), different request hashes.
    expect(scopeA).toBe('member:u1|POST|/api/v1/vouchers/:id/cancel');
    expect(scopeB).toBe(scopeA);
    expect(hashA).toBe(
      computeRequestHash({ method: 'POST', path: '/api/v1/vouchers/aaaa/cancel', body: undefined }),
    );
    expect(hashB).toBe(
      computeRequestHash({ method: 'POST', path: '/api/v1/vouchers/bbbb/cancel', body: undefined }),
    );
    expect(hashB).not.toBe(hashA);
  });

  it('replays stored responses and marks them', async () => {
    const { interceptor, service } = createInterceptor({
      kind: 'replay',
      status: 201,
      response: { id: 'r1' },
    });
    const { context, response } = createContext({ key: validKey, user: member });
    const handler: CallHandler = { handle: jest.fn() };
    const result = await lastValueFrom(await interceptor.intercept(context, handler));
    expect(result).toEqual({ id: 'r1' });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    expect(response.status).toHaveBeenCalledWith(201);
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('rejects mismatches and concurrent duplicates with 409 codes', async () => {
    const mismatch = createInterceptor({ kind: 'mismatch' });
    expect(
      await codeOf(
        mismatch.interceptor.intercept(createContext({ key: validKey }).context, next({})),
      ),
    ).toBe('PC_COMMON_IDEMPOTENCY_MISMATCH');
    const inProgress = createInterceptor({ kind: 'in_progress' });
    expect(
      await codeOf(
        inProgress.interceptor.intercept(createContext({ key: validKey }).context, next({})),
      ),
    ).toBe('PC_COMMON_IDEMPOTENCY_IN_PROGRESS');
  });

  it('releases the key it claimed when the handler fails', async () => {
    const { interceptor, service } = createInterceptor({ kind: 'proceed', claimedAt: CLAIMED_AT });
    const { context } = createContext({ key: validKey, user: member });
    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };
    await expect(lastValueFrom(await interceptor.intercept(context, failing))).rejects.toThrow(
      'boom',
    );
    expect(service.abandon).toHaveBeenCalledWith(
      'member:u1|POST|/api/v1/receipts/qr',
      validKey,
      CLAIMED_AT,
    );
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('still surfaces the handler error when releasing the key fails', async () => {
    const { interceptor, service } = createInterceptor({ kind: 'proceed' });
    service.abandon.mockRejectedValueOnce(new Error('db down'));
    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };
    await expect(
      lastValueFrom(await interceptor.intercept(createContext({ key: validKey }).context, failing)),
    ).rejects.toThrow('boom');
  });

  it('keeps the key in progress when storing the response fails after the handler committed', async () => {
    jest.useFakeTimers();
    const { interceptor, service } = createInterceptor({ kind: 'proceed', claimedAt: CLAIMED_AT });
    service.complete
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(true);
    const { context } = createContext({ key: validKey, user: member });

    // The client still receives the committed result; the key is NOT abandoned.
    const result = await lastValueFrom(await interceptor.intercept(context, next({ id: 'r1' })));
    expect(result).toEqual({ id: 'r1' });
    expect(service.abandon).not.toHaveBeenCalled();
    expect(service.complete).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(IDEMPOTENCY_STORE_RETRY_DELAYS_MS[0] ?? 0);
    expect(service.complete).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(IDEMPOTENCY_STORE_RETRY_DELAYS_MS[1] ?? 0);
    expect(service.complete).toHaveBeenCalledTimes(3);
    expect(service.complete).toHaveBeenLastCalledWith(
      'member:u1|POST|/api/v1/receipts/qr',
      validKey,
      201,
      { id: 'r1' },
      CLAIMED_AT,
    );
    // Stored on the third attempt: no further retries.
    await jest.advanceTimersByTimeAsync(600_000);
    expect(service.complete).toHaveBeenCalledTimes(3);
    expect(service.abandon).not.toHaveBeenCalled();
  });

  it('gives up after the configured retries without releasing the key', async () => {
    jest.useFakeTimers();
    const { interceptor, service } = createInterceptor({ kind: 'proceed' });
    interceptor.storeRetryDelaysMs = [10, 10];
    service.complete.mockRejectedValue(new Error('down'));
    await lastValueFrom(
      await interceptor.intercept(createContext({ key: validKey }).context, next('x')),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(service.complete).toHaveBeenCalledTimes(3);
    expect(service.abandon).not.toHaveBeenCalled();
  });

  it('builds scopes from the route path when available', () => {
    expect(
      buildIdempotencyScope({ headers: {}, ip: '1.1.1.1', originalUrl: '/api/v1/x?y=1' }, 'POST'),
    ).toBe('anon:1.1.1.1|POST|/api/v1/x');
  });

  it('derives the concrete path without query string or trailing slash', () => {
    expect(
      concreteRequestPath({ headers: {}, originalUrl: '/api/v1/vouchers/a/cancel/?x=1' }),
    ).toBe('/api/v1/vouchers/a/cancel');
    expect(concreteRequestPath({ headers: {}, url: '/' })).toBe('/');
    expect(concreteRequestPath({ headers: {}, route: { path: '/api/v1/t/:id' } })).toBe(
      '/api/v1/t/:id',
    );
  });
});
