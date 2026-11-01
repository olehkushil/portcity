import { Injectable } from '@nestjs/common';
import type { Tenant } from '@prisma/client';
import type { EffectiveTenantRule } from '../../../common/contracts/content';
import { Clock } from '../../../common/time/clock';
import { type TenantEarning, describeTenantEarning, needsBaseRate } from '../domain/tenant-earning';
import type {
  ListTenantsQueryDto,
  TenantCategoryCountDto,
  TenantDetailsDto,
  TenantPageDto,
} from '../dto/tenant.dto';
import { BaseRateService } from './base-rate.service';
import { MallInfoService } from './mall-info.service';
import { toTenantDetailsDto, toTenantListItemDto } from './mappers';
import { TenantRulesService } from './tenant-rules.service';
import { TenantsService } from './tenants.service';

/**
 * Public tenant directory (GET /tenants, GET /tenants/:slug, GET /tenants/by-id/:id): active
 * tenants only, each with the "нараховує бали" flag, the effective rate at the current moment,
 * the opening hours and "open now" (Kyiv time, the mall hours when the tenant has none).
 */
@Injectable()
export class TenantDirectoryService {
  constructor(
    private readonly tenants: TenantsService,
    private readonly rules: TenantRulesService,
    private readonly baseRate: BaseRateService,
    private readonly mallInfo: MallInfoService,
    private readonly clock: Clock,
  ) {}

  async list(query: ListTenantsQueryDto): Promise<TenantPageDto> {
    const page = await this.tenants.listPublic({
      participates: query.participates,
      category: query.category,
      floor: query.floor,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    const [described, view] = await Promise.all([
      this.describe(page.items),
      this.mallInfo.tenantViewContext(),
    ]);
    return {
      items: described.map(({ row, earning }) => toTenantListItemDto(row, earning, view)),
      nextCursor: page.nextCursor,
    };
  }

  async getBySlug(slug: string): Promise<TenantDetailsDto> {
    return this.details(await this.tenants.getPublicBySlug(slug));
  }

  /** Same card as by slug; hidden and closed tenants answer 404. */
  async getById(id: string): Promise<TenantDetailsDto> {
    return this.details(await this.tenants.getPublicById(id));
  }

  categories(): Promise<TenantCategoryCountDto[]> {
    return this.tenants.categoriesSummary();
  }

  /** Earning of one tenant (any status) at the current moment. */
  async describeOne(row: Tenant): Promise<TenantEarning> {
    const [described] = await this.describe([row]);
    return described?.earning ?? describeTenantEarning(row, noRule(row.id), 0);
  }

  private async details(row: Tenant): Promise<TenantDetailsDto> {
    const [earning, view] = await Promise.all([
      this.describeOne(row),
      this.mallInfo.tenantViewContext(),
    ]);
    return toTenantDetailsDto(row, earning, view);
  }

  /** One rules query per page; the base rate is read only when some tenant needs it. */
  private async describe<T extends Tenant>(
    rows: readonly T[],
  ): Promise<Array<{ row: T; earning: TenantEarning }>> {
    if (rows.length === 0) {
      return [];
    }
    const effective = await this.rules.getEffectiveRules(rows, this.clock.now());
    const resolved = rows.map((row) => ({ row, rule: effective.get(row.id) ?? noRule(row.id) }));
    const baseRate = resolved.some(({ row, rule }) => needsBaseRate(row, rule))
      ? await this.baseRate.getBaseRatePercent()
      : 0;
    return resolved.map(({ row, rule }) => ({
      row,
      earning: describeTenantEarning(row, rule, baseRate),
    }));
  }
}

function noRule(tenantId: string): EffectiveTenantRule {
  return { tenantId, ratePercent: null, minTotalKopecks: 0, dailyCapPoints: null, source: 'none' };
}
