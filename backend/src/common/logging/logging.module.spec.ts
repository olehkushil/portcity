import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import {
  REDACT_CENSOR,
  buildPinoHttpOptions,
  resolveRequestId,
  serializeRequest,
  stripQueryString,
} from './logging.module';

describe('logging options', () => {
  it('reuses safe inbound request ids and mints UUID v7 otherwise', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
    expect(resolveRequestId(['first', 'second'])).toBe('first');
    expect(resolveRequestId('has space')).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId('x'.repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('enables pretty transport only when requested', () => {
    const pretty = buildPinoHttpOptions({
      LOG_LEVEL: 'debug',
      LOG_PRETTY: true,
      APP_MODE: 'api',
      NODE_ENV: 'development',
    });
    expect(pretty.level).toBe('debug');
    expect(pretty.transport).toMatchObject({ target: 'pino-pretty' });

    const json = buildPinoHttpOptions({
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      APP_MODE: 'worker',
      NODE_ENV: 'production',
    });
    expect(json.transport).toBeUndefined();
    expect(json.base).toEqual({ service: 'portcity-backend', mode: 'worker' });
  });

  it('cuts query strings and fragments off URLs', () => {
    expect(stripQueryString('/api/v1/admin/users?q=0501234567&limit=5')).toBe(
      '/api/v1/admin/users',
    );
    expect(stripQueryString('/api/v1/me#x')).toBe('/api/v1/me');
    expect(stripQueryString('/api/v1/me')).toBe('/api/v1/me');
    expect(stripQueryString(undefined)).toBeUndefined();
  });

  it('serializes requests without query parameters and without touching the live headers', () => {
    const headers = { authorization: 'Bearer abc' };
    const serialized = serializeRequest({
      id: 'r-1',
      method: 'GET',
      url: '/api/v1/admin/users?q=%2B380501234567',
      headers,
      remoteAddress: '203.0.113.7',
      remotePort: 5000,
    });
    expect(serialized).toEqual({
      id: 'r-1',
      method: 'GET',
      url: '/api/v1/admin/users',
      params: undefined,
      headers: { authorization: 'Bearer abc' },
      remoteAddress: '203.0.113.7',
      remotePort: 5000,
    });
    expect(serialized).not.toHaveProperty('query');
    expect(serialized.headers).not.toBe(headers);
  });
});

/**
 * End-to-end proof through the real pino-http middleware with the production options (JSON, no
 * pretty transport): the log line must not contain any credential header value nor the query.
 */
describe('request log redaction (pino-http)', () => {
  function captureLogs(): { stream: Writable; lines: () => Array<Record<string, unknown>> } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    return {
      stream,
      lines: () =>
        chunks
          .join('')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  it('redacts credentials and drops the query string', async () => {
    const logs = captureLogs();
    const options = buildPinoHttpOptions({
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      APP_MODE: 'api',
      NODE_ENV: 'production',
    });
    const middleware = pinoHttp(options, logs.stream);
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      middleware(req, res);
      res.setHeader('Set-Cookie', 'session=secret-cookie-value');
      res.statusCode = 200;
      res.end('{}');
    };

    const secrets = {
      authorization: 'Bearer eyJsecret.token.value',
      cookie: 'sid=cookie-secret-value',
      'x-validator-key': 'validator-device-key-secret',
      'x-validator-shift': 'validator-shift-token-secret',
      'x-validator-pin': '987654',
      'idempotency-key': 'idem-key-secret-0001',
    };
    let call = request(handler).get('/api/v1/admin/users?q=%2B380501234567&status=active');
    for (const [name, value] of Object.entries(secrets)) {
      call = call.set(name, value);
    }
    await call.expect(200);

    const entries = logs.lines();
    const completed = entries.find((entry) => entry['msg'] === 'request completed');
    expect(completed).toBeDefined();
    const req = completed?.['req'] as { url: string; headers: Record<string, string> };
    expect(req.url).toBe('/api/v1/admin/users');
    expect(req).not.toHaveProperty('query');
    for (const name of Object.keys(secrets)) {
      expect(req.headers[name]).toBe(REDACT_CENSOR);
    }
    const res = completed?.['res'] as { headers: Record<string, string> };
    expect(res.headers['set-cookie']).toBe(REDACT_CENSOR);

    const raw = JSON.stringify(entries);
    for (const value of [
      ...Object.values(secrets),
      '380501234567',
      'secret-cookie-value',
      'status=active',
    ]) {
      expect(raw).not.toContain(value);
    }
  });
});
