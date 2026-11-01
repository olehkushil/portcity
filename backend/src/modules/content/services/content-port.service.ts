import { Injectable } from '@nestjs/common';
import type {
  ContentPort,
  EffectiveTenantRule,
  FiscalNumberLookup,
  TenantDisplaySummary,
  TenantSummary,
} from '../../../common/contracts/content';
import type { Tx } from '../../../common/prisma/prisma.service';
import { isTenantExcludedFromProgram } from '../domain/tenant-state';
import { FiscalNumbersService, type RecordSeenOptions } from './fiscal-numbers.service';
import { MallInfoService } from './mall-info.service';
import { toTenantDisplaySummary, toTenantSummary } from './mappers';
import { TenantRulesService } from './tenant-rules.service';
import { TenantsService } from './tenants.service';

/** CONTENT_PORT implementation consumed by receipts, rewards, promos and admin. */
@Injectable()
export class ContentPortService implements ContentPort {
  constructor(
    private readonly tenants: TenantsService,
    private readonly fiscalNumbers: FiscalNumbersService,
    private readonly rules: TenantRulesService,
    private readonly mallInfo: MallInfoService,
  ) {}

  async getTenant(tenantId: string): Promise<TenantSummary | null> {
    const row = await this.tenants.findById(tenantId);
    return row ? toTenantSummary(row) : null;
  }

  /** Card data for vouchers and promos: logo URL, location, map, open now (any status). */
  async getTenantSummaryById(tenantId: string): Promise<TenantDisplaySummary | null> {
    const row = await this.tenants.findById(tenantId);
    if (!row) {
      return null;
    }
    return toTenantDisplaySummary(row, await this.mallInfo.tenantViewContext());
  }

  async getTenants(tenantIds: readonly string[]): Promise<TenantSummary[]> {
    const rows = await this.tenants.findByIds(tenantIds);
    return rows.map(toTenantSummary);
  }

  findTenantByFiscalNumber(fn: string): Promise<FiscalNumberLookup | null> {
    return this.fiscalNumbers.lookup(fn);
  }

  /**
   * True when receipts from the tenant must not earn points: missing tenant, excluded by
   * policy, not a participant, or closed (see isTenantExcludedFromProgram).
   */
  async isExcluded(tenantId: string): Promise<boolean> {
    const row = await this.tenants.findById(tenantId);
    return row ? isTenantExcludedFromProgram(row) : true;
  }

  getTenantRule(tenantId: string, at: Date): Promise<EffectiveTenantRule> {
    return this.rules.getEffectiveRule(tenantId, at);
  }

  recordSeenFiscalNumber(
    fn: string,
    tx?: Tx,
    options?: RecordSeenOptions,
  ): Promise<FiscalNumberLookup> {
    return this.fiscalNumbers.recordSeen(fn, tx, options);
  }
}
