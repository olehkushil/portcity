/**
 * Error code registry. Codes follow `PC_<MODULE>_<REASON>` and map to a default HTTP status
 * and a short title used by the RFC 7807 filter. Each module defines its own codes with
 * `defineErrorCodes` in `src/modules/<name>/domain/errors.ts` (or similar) and throws
 * `new DomainError(MyErrors.PC_X_Y, 'human readable detail')`.
 */
export interface ErrorCodeDefinition {
  readonly status: number;
  readonly title: string;
}

export const ERROR_CODE_PATTERN = /^PC_[A-Z]+(?:_[A-Z0-9]+)+$/;

const registry = new Map<string, ErrorCodeDefinition>();

export function defineErrorCodes<const T extends Record<string, ErrorCodeDefinition>>(
  codes: T,
): { readonly [K in keyof T]: K } {
  const result: Record<string, string> = {};
  for (const [code, definition] of Object.entries(codes)) {
    if (!ERROR_CODE_PATTERN.test(code)) {
      throw new Error(`Invalid error code "${code}": expected PC_<MODULE>_<REASON>`);
    }
    if (
      !Number.isInteger(definition.status) ||
      definition.status < 400 ||
      definition.status > 599
    ) {
      throw new Error(`Invalid HTTP status for error code "${code}": ${definition.status}`);
    }
    const existing = registry.get(code);
    if (
      existing &&
      (existing.status !== definition.status || existing.title !== definition.title)
    ) {
      throw new Error(`Error code "${code}" is already registered with a different definition`);
    }
    registry.set(code, Object.freeze({ ...definition }));
    result[code] = code;
  }
  return Object.freeze(result) as { readonly [K in keyof T]: K };
}

export function getErrorCodeDefinition(code: string): ErrorCodeDefinition | undefined {
  return registry.get(code);
}

export function listErrorCodes(): ReadonlyMap<string, ErrorCodeDefinition> {
  return registry;
}

export const CommonErrors = defineErrorCodes({
  PC_COMMON_VALIDATION: { status: 400, title: 'Validation failed' },
  PC_COMMON_BAD_REQUEST: { status: 400, title: 'Bad request' },
  PC_COMMON_NOT_FOUND: { status: 404, title: 'Not found' },
  PC_COMMON_METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  PC_COMMON_CONFLICT: { status: 409, title: 'Conflict' },
  PC_COMMON_PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  PC_COMMON_UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  PC_COMMON_RATE_LIMITED: { status: 429, title: 'Too many requests' },
  PC_COMMON_INTERNAL: { status: 500, title: 'Internal server error' },
  PC_COMMON_NOT_IMPLEMENTED: { status: 501, title: 'Not implemented' },
  PC_COMMON_SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
  PC_COMMON_IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: 'Idempotency-Key header is required' },
  PC_COMMON_IDEMPOTENCY_KEY_INVALID: { status: 400, title: 'Idempotency-Key header is invalid' },
  PC_COMMON_IDEMPOTENCY_MISMATCH: {
    status: 409,
    title: 'Idempotency-Key was already used with a different request',
  },
  PC_COMMON_IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    title: 'A request with this Idempotency-Key is still being processed',
  },
  PC_COMMON_PHONE_INVALID: { status: 400, title: 'Phone number is invalid' },
  PC_COMMON_MONEY_INVALID: { status: 400, title: 'Money amount is invalid' },
  PC_COMMON_CURSOR_INVALID: { status: 400, title: 'Pagination cursor is invalid' },
  PC_AUTH_UNAUTHORIZED: { status: 401, title: 'Authentication required' },
  PC_AUTH_TOKEN_EXPIRED: { status: 401, title: 'Access token expired' },
  PC_AUTH_TOKEN_INVALID: { status: 401, title: 'Access token invalid' },
  PC_AUTH_FORBIDDEN: { status: 403, title: 'Forbidden' },
  PC_STORAGE_OBJECT_NOT_FOUND: { status: 404, title: 'Stored object not found' },
  PC_STORAGE_UNAVAILABLE: { status: 503, title: 'Object storage unavailable' },
});

export type CommonErrorCode = keyof typeof CommonErrors;
