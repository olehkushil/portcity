import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Receipt } from '@prisma/client';
import {
  CLUB_LEDGER_PORT,
  type ClubLedgerPort,
  DEFAULT_LOYALTY_RULES,
  type LoyaltyRules,
} from '../../../common/contracts/club';
import {
  CONTENT_PORT,
  type ContentPort,
  type TenantSummary,
} from '../../../common/contracts/content';
import { RECEIPT_PENDING_STATUSES, type ReceiptStatus } from '../../../common/contracts/receipts';
import { Clock } from '../../../common/time/clock';
import { kyivDayKey } from '../../../common/time/kyiv';
import { type RuleTenantRule, computePoints } from '../domain/rules';
import { toRuleTenant, toRuleTenantRule } from './receipt-pipeline.service';

export type EstimatableReceipt = Pick<
  Receipt,
  'id' | 'status' | 'tenantId' | 'totalKopecks' | 'issuedAt'
>;

const PENDING = new Set<ReceiptStatus>(RECEIPT_PENDING_STATUSES);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for statuses whose points are still to be decided (moderation or processing). */
export function isPendingStatus(status: ReceiptStatus): boolean {
  return PENDING.has(status);
}

/** A tenant that cannot earn points (closed, excluded, not participating). */
function earnsNothing(tenant: TenantSummary): boolean {
  return tenant.excludedFromProgram || !tenant.participates || tenant.status === 'closed';
}

/**
 * Estimated points of receipts that are not settled yet ("очікувані бали"): the same formula as
 * the credit (`computePoints`: tenant rule, override or base rate, maxPointsPerReceipt) without
 * the tenant daily cap, the verification hold or the moderator's decision. Used by
 * ReceiptDto.expectedPoints and RECEIPTS_PORT.getPendingSummary. Never throws: when the ledger
 * or content is unavailable the defaults are used and tenants are treated as unknown.
 */
@Injectable()
export class ExpectedPointsService {
  private readonly logger = new Logger(ExpectedPointsService.name);

  constructor(
    private readonly clock: Clock,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
  ) {}

  /** Expected points by receipt id, for the pending receipts among `rows` only. */
  async estimate(rows: readonly EstimatableReceipt[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const pending = rows.filter((row) => isPendingStatus(row.status));
    if (pending.length === 0) {
      return result;
    }
    const rules = await this.rules();
    const tenants = await this.tenants(pending);
    const ruleCache = new Map<string, RuleTenantRule | null>();
    for (const row of pending) {
      const tenant = row.tenantId ? (tenants.get(row.tenantId) ?? null) : null;
      if (tenant && earnsNothing(tenant)) {
        result.set(row.id, 0);
        continue;
      }
      const tenantRule = tenant ? await this.tenantRule(tenant.id, row.issuedAt, ruleCache) : null;
      result.set(
        row.id,
        computePoints({
          totalKopecks: row.totalKopecks,
          rules,
          tenant: toRuleTenant(tenant),
          tenantRule,
        }),
      );
    }
    return result;
  }

  async estimateOne(row: EstimatableReceipt): Promise<number | null> {
    return (await this.estimate([row])).get(row.id) ?? null;
  }

  private async rules(): Promise<LoyaltyRules> {
    try {
      return (await this.ledger.getActiveRules(this.clock.now())).rules;
    } catch (error) {
      this.logger.warn(`Active rules unavailable, estimating with defaults: ${describe(error)}`);
      return DEFAULT_LOYALTY_RULES;
    }
  }

  private async tenants(rows: readonly EstimatableReceipt[]): Promise<Map<string, TenantSummary>> {
    const ids = [...new Set(rows.map((row) => row.tenantId).filter((id): id is string => !!id))];
    const map = new Map<string, TenantSummary>();
    if (ids.length === 0) {
      return map;
    }
    try {
      for (const tenant of await this.content.getTenants(ids)) {
        map.set(tenant.id, tenant);
      }
    } catch (error) {
      this.logger.warn(`Tenant lookup failed while estimating points: ${describe(error)}`);
    }
    return map;
  }

  /** Rules rarely change within a day, so one lookup per tenant and Kyiv day is enough here. */
  private async tenantRule(
    tenantId: string,
    at: Date,
    cache: Map<string, RuleTenantRule | null>,
  ): Promise<RuleTenantRule | null> {
    const key = `${tenantId}|${kyivDayKey(at)}`;
    if (cache.has(key)) {
      return cache.get(key) ?? null;
    }
    let rule: RuleTenantRule | null = null;
    try {
      rule = toRuleTenantRule(await this.content.getTenantRule(tenantId, at));
    } catch (error) {
      this.logger.warn(`Tenant rule lookup failed for ${tenantId}: ${describe(error)}`);
    }
    cache.set(key, rule);
    return rule;
  }
}
