import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CLUB_LEDGER_PORT,
  type ClubLedgerPort,
  DEFAULT_LOYALTY_RULES,
} from '../../../common/contracts/club';
import { Clock } from '../../../common/time/clock';

/** How long a base rate read from the club port is reused (public endpoints are hot). */
export const BASE_RATE_CACHE_MS = 60_000;

/**
 * baseRatePercent of the active loyalty rule set, needed to show the effective rate of a
 * tenant without its own rule or override.
 *
 * ContentModule imports ClubModule for CLUB_LEDGER_PORT (club depends only on identity, so the
 * module graph stays acyclic). Club caches the active rule set itself and answers with
 * DEFAULT_LOYALTY_RULES when no version exists; the local fallback to the contract default
 * (3 %) only covers a failing ledger (database unavailable).
 */
@Injectable()
export class BaseRateService {
  private readonly logger = new Logger(BaseRateService.name);
  private cached: { value: number; expiresAt: number } | null = null;

  constructor(
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    private readonly clock: Clock,
  ) {}

  async getBaseRatePercent(): Promise<number> {
    const nowMs = this.clock.nowMs();
    if (this.cached && this.cached.expiresAt > nowMs) {
      return this.cached.value;
    }
    const value = await this.readFromClub();
    this.cached = { value, expiresAt: nowMs + BASE_RATE_CACHE_MS };
    return value;
  }

  /** Drops the cached value (tests, rule-set changes picked up immediately). */
  invalidate(): void {
    this.cached = null;
  }

  private async readFromClub(): Promise<number> {
    try {
      const active = await this.ledger.getActiveRules(this.clock.now());
      const rate = active.rules.baseRatePercent;
      return Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_LOYALTY_RULES.baseRatePercent;
    } catch (error) {
      this.logger.debug(
        `club.getActiveRules unavailable, using the default base rate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return DEFAULT_LOYALTY_RULES.baseRatePercent;
    }
  }
}
