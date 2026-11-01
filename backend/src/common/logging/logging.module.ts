import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { uuidv7 } from 'uuidv7';
import { APP_CONFIG, type AppConfig } from '../config';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuses a well-formed inbound `x-request-id`, otherwise mints a UUID v7. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : uuidv7();
}

const IGNORED_PATHS = new Set(['/health', '/ready']);

export const REDACT_CENSOR = '[REDACTED]';

/**
 * Credentials that must never reach the log: bearer tokens, cookies, validator device key /
 * shift token / PIN, idempotency keys (they let a replay fetch the stored response), and the few
 * secret-bearing body fields in case a body is ever logged.
 */
export const REDACTED_LOG_PATHS: readonly string[] = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-validator-key"]',
  'req.headers["x-validator-shift"]',
  'req.headers["x-validator-pin"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.code',
  'req.body.refreshToken',
  'req.body.pushToken',
]);

/** Path without the query string: admin searches put phones and e-mails into `?q=`. */
export function stripQueryString(url: string | undefined): string | undefined {
  if (typeof url !== 'string') {
    return url;
  }
  const index = url.search(/[?#]/);
  return index === -1 ? url : url.slice(0, index);
}

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
  params?: unknown;
  headers?: Record<string, unknown>;
  remoteAddress?: string;
  remotePort?: number;
}

/**
 * Request serializer: the standard pino fields minus `query` (personal data in search
 * parameters), with the URL cut at `?`. Headers are copied so redaction never touches the live
 * request object.
 */
export function serializeRequest(req: SerializedRequest): SerializedRequest {
  return {
    id: req.id,
    method: req.method,
    url: stripQueryString(req.url),
    params: req.params,
    headers: { ...(req.headers ?? {}) },
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

export function buildPinoHttpOptions(
  config: Pick<AppConfig, 'LOG_LEVEL' | 'LOG_PRETTY' | 'APP_MODE' | 'NODE_ENV'>,
): Options {
  const options: Options = {
    level: config.LOG_LEVEL,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customProps: (req: IncomingMessage) => ({
      requestId: (req as IncomingMessage & { id?: unknown }).id,
    }),
    autoLogging: {
      ignore: (req: IncomingMessage) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        return IGNORED_PATHS.has(path) || path.startsWith('/docs');
      },
    },
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) {
        return 'error';
      }
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
    serializers: {
      req: (req: SerializedRequest) => serializeRequest(req),
    },
    redact: {
      paths: [...REDACTED_LOG_PATHS],
      censor: REDACT_CENSOR,
    },
    base: { service: 'portcity-backend', mode: config.APP_MODE },
  };
  if (config.LOG_PRETTY) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,mode',
      },
    };
  }
  return options;
}

/** nestjs-pino logger with request ids; `app.useLogger(app.get(Logger))` in the entrypoints. */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ pinoHttp: buildPinoHttpOptions(config) }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
