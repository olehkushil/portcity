import { HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import {
  isDatabaseUnavailable,
  isRecordNotFound,
  isUniqueViolation,
} from '../prisma/prisma.errors';
import { DomainError } from './domain-error';
import { CommonErrors, ERROR_CODE_PATTERN, getErrorCodeDefinition } from './error-codes';
import { type ProblemDetails, type ValidationIssue, problemTypeFor } from './problem-details';

export interface ProblemContext {
  instance?: string;
  requestId?: string;
  /** When false (production) internal error messages are replaced by a generic text. */
  exposeInternalErrors: boolean;
}

const STATUS_TO_CODE: Record<number, string> = {
  400: CommonErrors.PC_COMMON_BAD_REQUEST,
  401: CommonErrors.PC_AUTH_UNAUTHORIZED,
  403: CommonErrors.PC_AUTH_FORBIDDEN,
  404: CommonErrors.PC_COMMON_NOT_FOUND,
  405: CommonErrors.PC_COMMON_METHOD_NOT_ALLOWED,
  409: CommonErrors.PC_COMMON_CONFLICT,
  413: CommonErrors.PC_COMMON_PAYLOAD_TOO_LARGE,
  415: CommonErrors.PC_COMMON_UNSUPPORTED_MEDIA_TYPE,
  422: CommonErrors.PC_COMMON_VALIDATION,
  429: CommonErrors.PC_COMMON_RATE_LIMITED,
  500: CommonErrors.PC_COMMON_INTERNAL,
  501: CommonErrors.PC_COMMON_NOT_IMPLEMENTED,
  503: CommonErrors.PC_COMMON_SERVICE_UNAVAILABLE,
};

const GENERIC_INTERNAL_DETAIL = 'Unexpected error. Please retry later or contact support.';

function codeForStatus(status: number): string {
  const known = STATUS_TO_CODE[status];
  if (known) {
    return known;
  }
  return status >= 500 ? CommonErrors.PC_COMMON_INTERNAL : CommonErrors.PC_COMMON_BAD_REQUEST;
}

function titleFor(code: string, status: number): string {
  return getErrorCodeDefinition(code)?.title ?? (HttpStatus[status] ?? 'Error').replace(/_/g, ' ');
}

function base(
  code: string,
  status: number,
  detail: string | undefined,
  context: ProblemContext,
  title?: string,
): ProblemDetails {
  const problem: ProblemDetails = {
    type: problemTypeFor(code),
    title: title ?? titleFor(code, status),
    status,
    code,
  };
  if (detail) {
    problem.detail = detail;
  }
  if (context.instance) {
    problem.instance = context.instance;
  }
  if (context.requestId) {
    problem.requestId = context.requestId;
  }
  return problem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromHttpException(exception: HttpException, context: ProblemContext): ProblemDetails {
  const status = exception.getStatus();
  const response = exception.getResponse();
  let code = codeForStatus(status);
  let detail: string | undefined = exception.message;
  let errors: ValidationIssue[] | undefined;
  let details: unknown;

  if (exception instanceof ThrottlerException) {
    code = CommonErrors.PC_COMMON_RATE_LIMITED;
    detail = 'Rate limit exceeded. Please slow down.';
  } else if (typeof response === 'string') {
    detail = response;
  } else if (isRecord(response)) {
    if (typeof response['code'] === 'string' && ERROR_CODE_PATTERN.test(response['code'])) {
      code = response['code'];
    }
    const message = response['message'];
    if (Array.isArray(message)) {
      // Default ValidationPipe shape: { statusCode, message: string[], error }
      code = CommonErrors.PC_COMMON_VALIDATION;
      detail = 'Request validation failed';
      errors = [{ path: '', messages: message.map(String) }];
    } else if (typeof message === 'string') {
      detail = message;
    }
    if (Array.isArray(response['errors'])) {
      errors = response['errors'] as ValidationIssue[];
    }
    if (response['details'] !== undefined) {
      details = response['details'];
    }
  }

  const problem = base(code, status, detail, context);
  if (errors) {
    problem.errors = errors;
  }
  if (details !== undefined) {
    problem.details = details;
  }
  return problem;
}

function fromDomainError(error: DomainError, context: ProblemContext): ProblemDetails {
  const problem = base(error.code, error.status, error.message, context, error.title);
  if (error.details !== undefined) {
    if (
      error.code === CommonErrors.PC_COMMON_VALIDATION &&
      Array.isArray(error.details) &&
      error.details.every((item) => isRecord(item) && typeof item['path'] === 'string')
    ) {
      problem.errors = error.details as ValidationIssue[];
    } else {
      problem.details = error.details;
    }
  }
  return problem;
}

/** Express/body-parser style errors carry `status`/`statusCode` and `expose`. */
function fromExposedError(error: Record<string, unknown>, context: ProblemContext): ProblemDetails {
  const status = Number(error['status'] ?? error['statusCode']);
  const message = typeof error['message'] === 'string' ? error['message'] : undefined;
  return base(codeForStatus(status), status, message, context);
}

/** Maps any thrown value to an RFC 7807 document. Pure: no logging, no framework objects. */
export function toProblemDetails(exception: unknown, context: ProblemContext): ProblemDetails {
  if (DomainError.is(exception)) {
    return fromDomainError(exception, context);
  }
  if (exception instanceof HttpException) {
    return fromHttpException(exception, context);
  }
  if (isUniqueViolation(exception)) {
    return base(
      CommonErrors.PC_COMMON_CONFLICT,
      409,
      'A record with the same unique value already exists',
      context,
    );
  }
  if (isRecordNotFound(exception)) {
    return base(CommonErrors.PC_COMMON_NOT_FOUND, 404, 'Record not found', context);
  }
  if (isDatabaseUnavailable(exception)) {
    return base(
      CommonErrors.PC_COMMON_SERVICE_UNAVAILABLE,
      503,
      'Database is temporarily unavailable',
      context,
    );
  }
  if (isRecord(exception)) {
    const status = Number(exception['status'] ?? exception['statusCode']);
    if (Number.isInteger(status) && status >= 400 && status < 500 && exception['expose'] === true) {
      return fromExposedError(exception, context);
    }
  }

  const message =
    context.exposeInternalErrors && exception instanceof Error && exception.message
      ? exception.message
      : GENERIC_INTERNAL_DETAIL;
  return base(CommonErrors.PC_COMMON_INTERNAL, 500, message, context);
}
