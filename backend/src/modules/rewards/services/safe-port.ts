import type { Logger } from '@nestjs/common';

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Runs an enrichment-only call to another module's port (tenant names, parking session) and
 * falls back when it fails, so a stubbed or degraded neighbour never breaks a rewards flow.
 * Never use it for calls with a financial effect (the ledger is always called directly).
 */
export async function tryPort<T>(
  logger: Logger,
  what: string,
  call: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    logger.warn(`${what} unavailable, continuing without it: ${describe(error)}`);
    return fallback;
  }
}
