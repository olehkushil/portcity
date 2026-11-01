import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config';
import { stripQueryString } from '../logging/logging.module';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from './problem-details';
import { toProblemDetails } from './to-problem-details';

interface RequestLike {
  id?: unknown;
  originalUrl?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Global exception filter rendering every error as `application/problem+json`
 * (RFC 7807) with the PortCity extensions `code` and `requestId`.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);
  private readonly exposeInternalErrors: boolean;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    @Optional() @Inject(APP_CONFIG) config?: AppConfig,
  ) {
    this.exposeInternalErrors = config ? !config.isProduction : true;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.logger.error(
        `Unhandled exception outside HTTP context: ${describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      return;
    }

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestLike>();
    const response = ctx.getResponse<unknown>();
    const requestId = extractRequestId(request);

    const problem = toProblemDetails(exception, {
      instance: request.originalUrl ?? request.url,
      requestId,
      exposeInternalErrors: this.exposeInternalErrors,
    });

    this.log(exception, problem, request);

    const { httpAdapter } = this.httpAdapterHost;
    httpAdapter.setHeader(response, 'Content-Type', PROBLEM_CONTENT_TYPE);
    httpAdapter.setHeader(response, 'Cache-Control', 'no-store');
    if (problem.status === 401) {
      httpAdapter.setHeader(response, 'WWW-Authenticate', 'Bearer realm="portcity"');
    }
    if (requestId) {
      httpAdapter.setHeader(response, 'x-request-id', requestId);
    }
    httpAdapter.reply(response, problem, problem.status);
  }

  private log(exception: unknown, problem: ProblemDetails, request: RequestLike): void {
    // Path only: query strings carry personal data (admin search ?q=<phone|e-mail>), the same
    // rule as the request log serializer. The response itself keeps the full instance.
    const path = stripQueryString(problem.instance) ?? '?';
    const summary = `${request.method ?? '?'} ${path} -> ${problem.status} ${problem.code}`;
    if (problem.status >= 500) {
      this.logger.error(
        `${summary}: ${describe(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.debug(`${summary}: ${problem.detail ?? ''}`);
    }
  }
}

function extractRequestId(request: RequestLike): string | undefined {
  if (typeof request.id === 'string' || typeof request.id === 'number') {
    return String(request.id);
  }
  const header = request.headers?.['x-request-id'];
  return typeof header === 'string' ? header : undefined;
}

function describe(exception: unknown): string {
  if (exception instanceof Error) {
    return `${exception.name}: ${exception.message}`;
  }
  return typeof exception === 'string' ? exception : JSON.stringify(exception);
}
