import { getErrorCodeDefinition } from './error-codes';

export interface DomainErrorOptions {
  /** Overrides the HTTP status registered for the code. */
  status?: number;
  /** Overrides the title registered for the code. */
  title?: string;
  /** Machine-readable extra information returned to the client (must be JSON-serialisable). */
  details?: unknown;
  cause?: unknown;
}

/**
 * Business error with a stable code (`PC_<MODULE>_<REASON>`), rendered as
 * `application/problem+json` by ProblemDetailsFilter.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly details: unknown;

  constructor(code: string, message?: string, options: DomainErrorOptions = {}) {
    const definition = getErrorCodeDefinition(code);
    super(message ?? definition?.title ?? code, {
      cause: options.cause,
    });
    this.name = 'DomainError';
    this.code = code;
    this.status = options.status ?? definition?.status ?? 400;
    this.title = options.title ?? definition?.title ?? 'Error';
    this.details = options.details;
  }

  static is(error: unknown): error is DomainError {
    if (error instanceof DomainError) {
      return true;
    }
    // Duck typing covers class identity mismatches between module registries (e.g. in tests).
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'DomainError' &&
      typeof (error as { code?: unknown }).code === 'string' &&
      typeof (error as { status?: unknown }).status === 'number'
    );
  }
}
