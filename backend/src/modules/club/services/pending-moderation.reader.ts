import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { RECEIPTS_PORT } from '../../../common/contracts/receipts';

/** Receipts waiting for a moderator and the points they would bring ("на перевірці"). */
export interface PendingModerationSummary {
  count: number;
  expectedPoints: number;
}

export const NO_PENDING_MODERATION: Readonly<PendingModerationSummary> = Object.freeze({
  count: 0,
  expectedPoints: 0,
});

/**
 * The part of RECEIPTS_PORT the card needs. Typed as optional on purpose: the receipts module
 * adds `getPendingSummary` independently, and an older or stubbed port must not break the card.
 */
export interface PendingSummaryCapablePort {
  getPendingSummary?: (userId: string) => Promise<PendingModerationSummary>;
}

/** Narrow view of ModuleRef (tests pass a plain object). */
export interface PortLocator {
  get<T = unknown>(token: symbol, options: { strict: false }): T;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Reads `RECEIPTS_PORT.getPendingSummary(userId)` for `GET /club/account`. Club cannot import
 * ReceiptsModule (receipts imports club), so the port is looked up lazily in the application
 * container (`ModuleRef.get(..., { strict: false })`). A missing port, a missing method or a
 * failing call yields zeros: the summary is informative only.
 */
@Injectable()
export class PendingModerationReader {
  private readonly logger = new Logger(PendingModerationReader.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  async getPendingSummary(userId: string): Promise<PendingModerationSummary> {
    const port = this.port();
    if (!port || typeof port.getPendingSummary !== 'function') {
      return { ...NO_PENDING_MODERATION };
    }
    try {
      const summary = await port.getPendingSummary(userId);
      return {
        count: nonNegativeInteger(summary?.count),
        expectedPoints: nonNegativeInteger(summary?.expectedPoints),
      };
    } catch (error) {
      this.logger.warn(
        `receipts.getPendingSummary unavailable, showing zeros: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { ...NO_PENDING_MODERATION };
    }
  }

  private port(): PendingSummaryCapablePort | null {
    try {
      return (this.moduleRef as unknown as PortLocator).get<PendingSummaryCapablePort>(
        RECEIPTS_PORT,
        { strict: false },
      );
    } catch {
      return null;
    }
  }
}
