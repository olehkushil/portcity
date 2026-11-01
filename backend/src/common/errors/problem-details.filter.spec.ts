import { type ArgumentsHost, Logger } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { DomainError } from './domain-error';
import { CommonErrors } from './error-codes';
import { ProblemDetailsFilter } from './problem-details.filter';

function httpHost(url: string): { host: ArgumentsHost; replies: unknown[] } {
  const replies: unknown[] = [];
  const request = { method: 'GET', originalUrl: url, url, headers: {} };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { host, replies };
}

function filterWith(replies: unknown[]): ProblemDetailsFilter {
  const adapterHost = {
    httpAdapter: {
      setHeader: () => undefined,
      reply: (_response: unknown, body: unknown) => {
        replies.push(body);
      },
    },
  } as unknown as HttpAdapterHost;
  return new ProblemDetailsFilter(adapterHost);
}

describe('ProblemDetailsFilter logging', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs the path without the query string (personal data in admin searches)', () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { host, replies } = httpHost('/api/v1/admin/users?q=%2B380501234567&limit=5');
    filterWith(replies).catch(new DomainError(CommonErrors.PC_COMMON_NOT_FOUND, 'missing'), host);

    const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('GET /api/v1/admin/users -> 404');
    expect(logged).not.toContain('380501234567');
    expect(logged).not.toContain('?');
  });

  it('logs server errors without the query string as well', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, replies } = httpHost('/api/v1/admin/users?q=oleh%40example.com');
    filterWith(replies).catch(new Error('boom'), host);

    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('GET /api/v1/admin/users -> 500');
    expect(logged).not.toContain('example.com');
  });

  it('keeps the full instance in the response sent to the caller', () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { host, replies } = httpHost('/api/v1/tenants?q=kava');
    filterWith(replies).catch(new DomainError(CommonErrors.PC_COMMON_NOT_FOUND, 'missing'), host);

    expect(replies).toEqual([expect.objectContaining({ instance: '/api/v1/tenants?q=kava' })]);
  });
});
