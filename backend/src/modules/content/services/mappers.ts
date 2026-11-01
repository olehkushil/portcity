import type {
  ContentImportRun,
  Tenant,
  TenantFiscalNumber,
  TenantLoyaltyRule,
} from '@prisma/client';
import type {
  FiscalNumberLookup,
  TenantDisplaySummary,
  TenantSummary,
} from '../../../common/contracts/content';
import type { ContentImportRunDto, ContentImportStatsDto } from '../dto/content-import.dto';
import type { FiscalNumberDto } from '../dto/fiscal-number.dto';
import type { HoursRange } from '../domain/mall-hours';
import type { TenantEarning } from '../domain/tenant-earning';
import { isTenantOpenAt, readTenantHours } from '../domain/tenant-hours';
import type { TenantRuleDto } from '../dto/tenant-rule.dto';
import type {
  TenantAdminDto,
  TenantDetailsDto,
  TenantListItemDto,
  TenantPublicDto,
} from '../dto/tenant.dto';

export type TenantWithCounts = Tenant & {
  _count?: { fiscalNumbers: number; loyaltyRules: number };
};

export type FiscalNumberWithTenant = TenantFiscalNumber & { tenant: Tenant | null };

export function toTenantSummary(row: Tenant): TenantSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    floor: row.floor,
    logoKey: row.logoKey,
    participates: row.participates,
    ratePercentOverride: row.ratePercentOverride,
    excludedFromProgram: row.excludedFromProgram,
    status: row.status,
  };
}

/** `${base}/${key}` without duplicate slashes; null when either part is missing. */
export function buildLogoUrl(base: string | undefined, key: string | null): string | null {
  if (!base || !key) {
    return null;
  }
  return `${base.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

/** What a tenant card needs besides the row (MallInfoService.tenantViewContext()). */
export interface TenantView {
  logoBase: string | undefined;
  /** Mall hours: the fallback for tenants (or days) without own hours. */
  mallHours: HoursRange;
  now: Date;
}

export function toTenantPublicDto(row: Tenant, view: TenantView): TenantPublicDto {
  const hours = readTenantHours(row.hours);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    floor: row.floor,
    logoUrl: buildLogoUrl(view.logoBase, row.logoKey),
    website: row.website,
    phone: row.phone,
    description: row.description,
    participates: row.participates,
    hours,
    isOpenNow: isTenantOpenAt(hours, view.mallHours, view.now),
    locationText: row.locationText,
    mapImageUrl: row.mapImageUrl,
  };
}

/** ContentPort.getTenantSummaryById: TenantSummary plus the card fields. */
export function toTenantDisplaySummary(row: Tenant, view: TenantView): TenantDisplaySummary {
  const card = toTenantPublicDto(row, view);
  return {
    ...toTenantSummary(row),
    logoUrl: card.logoUrl,
    locationText: card.locationText,
    mapImageUrl: card.mapImageUrl,
    isOpenNow: card.isOpenNow,
  };
}

export function toTenantListItemDto(
  row: Tenant,
  earning: TenantEarning,
  view: TenantView,
): TenantListItemDto {
  return {
    ...toTenantPublicDto(row, view),
    earnsPoints: earning.earnsPoints,
    effectiveRatePercent: earning.effectiveRatePercent,
    rateSource: earning.rateSource,
  };
}

export function toTenantDetailsDto(
  row: Tenant,
  earning: TenantEarning,
  view: TenantView,
): TenantDetailsDto {
  return {
    ...toTenantListItemDto(row, earning, view),
    minTotalKopecks: earning.minTotalKopecks,
    dailyCapPoints: earning.dailyCapPoints,
  };
}

export function toTenantAdminDto(row: TenantWithCounts, view: TenantView): TenantAdminDto {
  return {
    ...toTenantPublicDto(row, view),
    logoKey: row.logoKey,
    ratePercentOverride: row.ratePercentOverride,
    excludedFromProgram: row.excludedFromProgram,
    status: row.status,
    fiscalNumbersCount: row._count?.fiscalNumbers ?? 0,
    loyaltyRulesCount: row._count?.loyaltyRules ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toFiscalNumberLookup(row: FiscalNumberWithTenant): FiscalNumberLookup {
  return {
    fn: row.fn,
    status: row.status,
    source: row.source,
    tenantId: row.tenantId,
    tenant: row.tenant ? toTenantSummary(row.tenant) : null,
    firstSeenAt: row.firstSeenAt,
  };
}

export function toFiscalNumberDto(row: FiscalNumberWithTenant): FiscalNumberDto {
  return {
    id: row.id,
    fn: row.fn,
    tenantId: row.tenantId,
    tenant: row.tenant ? toTenantSummary(row.tenant) : null,
    status: row.status,
    source: row.source,
    firstSeenAt: row.firstSeenAt,
    confirmedById: row.confirmedById,
    confirmedAt: row.confirmedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toTenantRuleDto(row: TenantLoyaltyRule): TenantRuleDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ratePercent: row.ratePercent,
    minTotalKopecks: row.minTotalKopecks,
    dailyCapPoints: row.dailyCapPoints,
    validFrom: row.validFrom,
    validTo: row.validTo,
    createdAt: row.createdAt,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toImportRunDto(row: ContentImportRun): ContentImportRunDto {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    // stats is written by ContentImportService from ContentImportStats, so the shape matches.
    stats: isPlainObject(row.stats) ? (row.stats as unknown as ContentImportStatsDto) : null,
    error: row.error,
  };
}
