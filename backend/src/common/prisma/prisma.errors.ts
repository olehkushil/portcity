import { Prisma } from '@prisma/client';

/** Prisma error code reference: https://www.prisma.io/docs/orm/reference/error-reference */
export function isPrismaKnownError(
  error: unknown,
  code?: string,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (code === undefined || error.code === code)
  );
}

/** Unique constraint violation (P2002). */
export function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return isPrismaKnownError(error, 'P2002');
}

/** Foreign key constraint violation (P2003). */
export function isForeignKeyViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return isPrismaKnownError(error, 'P2003');
}

/** Record required by update/delete was not found (P2025). */
export function isRecordNotFound(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return isPrismaKnownError(error, 'P2025');
}

/** Connection-level failures: the database is unreachable or refused the connection. */
export function isDatabaseUnavailable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientInitializationError ||
    isPrismaKnownError(error, 'P1001') ||
    isPrismaKnownError(error, 'P1002') ||
    isPrismaKnownError(error, 'P1017')
  );
}
