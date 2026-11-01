import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { type Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import { IdempotencyService } from './idempotency.service';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  computeRequestHash,
} from './request-hash';

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * Background retries of a failed response store (ms after the previous attempt). They add up to
 * 111 s, inside the default lease of 120 s, so a retry of the client sees `in_progress` (409)
 * and then the stored response instead of a second execution.
 */
export const IDEMPOTENCY_STORE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  1_000, 5_000, 15_000, 30_000, 60_000,
]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface IdempotentRequest extends AuthenticatedRequest {
  body?: unknown;
  path?: string;
  route?: { path?: string };
}

interface ResponseLike {
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * `member:<id>|POST|/api/v1/vouchers/:id/cancel`: keys are private to a principal and a route
 * template. The concrete resource is part of the request hash (see `concreteRequestPath`), so
 * reusing a key on another resource of the same route is a mismatch (409), never a replay.
 */
export function buildIdempotencyScope(request: IdempotentRequest, method: string): string {
  const principal = request.user
    ? `${request.user.type}:${request.user.id}`
    : `anon:${request.ip ?? 'unknown'}`;
  const routePath =
    request.route?.path ?? request.path ?? (request.originalUrl ?? request.url ?? '').split('?')[0];
  return `${principal}|${method}|${routePath ?? ''}`;
}

/**
 * The path the client actually called, without the query string and a trailing slash, e.g.
 * `/api/v1/vouchers/0194.../cancel`. Falls back to the route template when the request carries
 * no URL (unit-test doubles).
 */
export function concreteRequestPath(request: IdempotentRequest): string {
  const raw = (request.originalUrl ?? request.url ?? request.path ?? '').split('?')[0] ?? '';
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  return path || (request.route?.path ?? '');
}

/**
 * Implements the Idempotency-Key protocol (brief section 3) for mutation endpoints:
 * same key + same request (method, concrete path, body) -> stored response is replayed;
 * same key + different body or resource -> 409 mismatch; concurrent duplicate -> 409 in
 * progress; handler failure releases the key. Once the handler succeeded the key is never
 * released: a failed response store keeps the row in progress and is retried in the
 * background (a crashed request is recovered by the lease in IdempotencyService.begin).
 * Apply with `@Idempotent()`.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  /** Overridable in tests. */
  storeRetryDelaysMs: readonly number[] = IDEMPOTENCY_STORE_RETRY_DELAYS_MS;

  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const response = http.getResponse<ResponseLike>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (!MUTATING_METHODS.has(method)) {
      return next.handle();
    }

    const key = headerValue(request.headers[IDEMPOTENCY_KEY_HEADER]);
    if (!key) {
      throw new DomainError(
        CommonErrors.PC_COMMON_IDEMPOTENCY_KEY_REQUIRED,
        'Send an Idempotency-Key header (8-128 chars: letters, digits, "_", "-", ".", ":"), for example a UUID',
      );
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new DomainError(
        CommonErrors.PC_COMMON_IDEMPOTENCY_KEY_INVALID,
        'Idempotency-Key must be 8-128 characters: letters, digits, "_", "-", ".", ":"',
      );
    }

    const scope = buildIdempotencyScope(request, method);
    const requestHash = computeRequestHash({
      method,
      path: concreteRequestPath(request),
      body: request.body,
    });
    const begin = await this.idempotency.begin(scope, key, requestHash);

    switch (begin.kind) {
      case 'mismatch':
        throw new DomainError(
          CommonErrors.PC_COMMON_IDEMPOTENCY_MISMATCH,
          'This Idempotency-Key was already used with a different request',
        );
      case 'in_progress':
        throw new DomainError(
          CommonErrors.PC_COMMON_IDEMPOTENCY_IN_PROGRESS,
          'A request with this Idempotency-Key is still being processed; retry shortly',
        );
      case 'replay':
        response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        response.status(begin.status);
        return of(begin.response);
      case 'proceed':
        break;
    }
    const claimedAt = begin.claimedAt;
    if (begin.tookOver) {
      this.logger.warn(
        `Idempotency-Key ${key} (${scope}): took over an in-progress key older than the lease`,
      );
    }

    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (method === 'POST' ? 201 : 200);

    return next.handle().pipe(
      // Only handler failures release the key; errors of the store step below never get here.
      catchError((error: unknown) =>
        from(this.release(scope, key, claimedAt)).pipe(mergeMap(() => throwError(() => error))),
      ),
      mergeMap(async (body: unknown) => {
        await this.store(scope, key, successStatus, body, claimedAt);
        return body;
      }),
    );
  }

  /** Handler failed (nothing committed): release the key so the client may retry. */
  private async release(scope: string, key: string, claimedAt: Date | undefined): Promise<void> {
    try {
      await this.idempotency.abandon(scope, key, claimedAt);
    } catch (error) {
      // The row stays in progress until the lease ends; the handler error is what the client needs.
      this.logger.error(
        `Idempotency-Key ${key} (${scope}): could not release the key after a handler failure`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * The handler committed: store its response. A failure must not release the key (a retry
   * would execute the operation twice), so the row stays in progress, the failure is logged and
   * the store is retried in the background; the client still gets the committed result.
   */
  private async store(
    scope: string,
    key: string,
    status: number,
    body: unknown,
    claimedAt: Date | undefined,
  ): Promise<void> {
    try {
      const stored = await this.idempotency.complete(scope, key, status, body, claimedAt);
      if (stored === false) {
        this.logger.warn(
          `Idempotency-Key ${key} (${scope}): response not stored, the key is no longer owned by this request`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Idempotency-Key ${key} (${scope}): storing the response failed after the handler committed; the key stays in progress and the store is retried`,
        error instanceof Error ? error.stack : String(error),
      );
      this.scheduleStoreRetry(scope, key, status, body, claimedAt, 0);
    }
  }

  private scheduleStoreRetry(
    scope: string,
    key: string,
    status: number,
    body: unknown,
    claimedAt: Date | undefined,
    attempt: number,
  ): void {
    const delay = this.storeRetryDelaysMs[attempt];
    if (delay === undefined) {
      this.logger.error(
        `Idempotency-Key ${key} (${scope}): giving up storing the response after ${attempt} retries; the key stays in progress until its lease ends`,
      );
      return;
    }
    const timer = setTimeout(() => {
      void this.retryStore(scope, key, status, body, claimedAt, attempt);
    }, delay);
    timer.unref?.();
  }

  private async retryStore(
    scope: string,
    key: string,
    status: number,
    body: unknown,
    claimedAt: Date | undefined,
    attempt: number,
  ): Promise<void> {
    try {
      await this.idempotency.complete(scope, key, status, body, claimedAt);
      this.logger.log(`Idempotency-Key ${key} (${scope}): response stored on retry ${attempt + 1}`);
    } catch (error) {
      this.logger.warn(
        `Idempotency-Key ${key} (${scope}): store retry ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleStoreRetry(scope, key, status, body, claimedAt, attempt + 1);
    }
  }
}
