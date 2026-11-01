import type { Receipt, ReceiptAppeal, ReceiptEvent } from '@prisma/client';
import type { LedgerEntry } from '../../../common/contracts/club';
import type { TenantSummary } from '../../../common/contracts/content';
import {
  RISK_FLAGS,
  type ReceiptErrorCode,
  type ReceiptSummary,
  type RiskFlag,
} from '../../../common/contracts/receipts';
import { canAppealWith } from '../domain/state-machine';
import { parseModerationReasons, parseRejectionCode } from '../domain/submission-view';
import type {
  AdminReceiptAppealDto,
  AdminReceiptDetailDto,
  AdminReceiptDto,
  AdminReceiptEventDto,
  ReceiptAppealDto,
  ReceiptDetailDto,
  ReceiptDto,
  ReceiptEventDto,
  ReceiptPointsDto,
  ReceiptTenantDto,
} from '../dto/receipt-responses.dto';

/** Pure mapping from Prisma rows to contract summaries and response DTOs. */

export function iso(date: Date): string;
export function iso(date: Date | null | undefined): string | null;
export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Receipt.riskFlags is a JSON column; keep only known flags. */
export function parseRiskFlags(value: unknown): RiskFlag[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const known = new Set<string>(RISK_FLAGS);
  const flags: RiskFlag[] = [];
  for (const item of value) {
    if (typeof item === 'string' && known.has(item) && !flags.includes(item as RiskFlag)) {
      flags.push(item as RiskFlag);
    }
  }
  return flags;
}

export function toReceiptSummary(row: Receipt): ReceiptSummary {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    fn: row.fn,
    fiscalId: row.fiscalId,
    issuedAt: row.issuedAt,
    totalKopecks: row.totalKopecks,
    source: row.source,
    tenantId: row.tenantId,
    status: row.status,
    riskFlags: parseRiskFlags(row.riskFlags),
    riskScore: row.riskScore,
    pointsAwarded: row.pointsAwarded,
    pointsTxId: row.pointsTxId,
    moderatorId: row.moderatorId,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt,
    submittedAt: row.submittedAt,
  };
}

export function toTenantDto(tenant: TenantSummary | null | undefined): ReceiptTenantDto | null {
  return tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null;
}

export function toPointsDto(entry: LedgerEntry | null): ReceiptPointsDto | null {
  return entry
    ? {
        awarded: entry.amount,
        state: entry.state,
        availableAt: iso(entry.availableAt),
        expiresAt: iso(entry.expiresAt),
      }
    : null;
}

export function toReceiptDto(
  row: Receipt,
  tenant: ReceiptTenantDto | null,
  appealCount = 0,
  expectedPoints: number | null = null,
): ReceiptDto {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    fn: row.fn,
    fiscalId: row.fiscalId,
    issuedAt: iso(row.issuedAt),
    totalKopecks: row.totalKopecks,
    tenant,
    pointsAwarded: row.pointsAwarded,
    expectedPoints,
    decisionReason: row.decisionReason,
    decidedAt: iso(row.decidedAt),
    submittedAt: iso(row.submittedAt),
    canAppeal: canAppealWith(row.status, appealCount),
  };
}

export function toEventDto(event: ReceiptEvent): ReceiptEventDto {
  return {
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actorType: event.actorType,
    createdAt: iso(event.createdAt),
  };
}

export function toAdminEventDto(event: ReceiptEvent): AdminReceiptEventDto {
  return { ...toEventDto(event), actorId: event.actorId, note: event.note };
}

export function toAppealDto(appeal: ReceiptAppeal): ReceiptAppealDto {
  return {
    id: appeal.id,
    message: appeal.message,
    createdAt: iso(appeal.createdAt),
    resolvedAt: iso(appeal.resolvedAt),
    resolution: appeal.resolution,
  };
}

export function toAdminAppealDto(
  appeal: ReceiptAppeal,
  photoUrl: string | null,
): AdminReceiptAppealDto {
  return { ...toAppealDto(appeal), photoUrl, resolvedById: appeal.resolvedById };
}

export interface ReceiptDetailParts {
  tenant: ReceiptTenantDto | null;
  photoUrl: string | null;
  points: ReceiptPointsDto | null;
  events: ReceiptEvent[];
  appeals: ReceiptAppeal[];
  /** Ukrainian "Причина перевірки" lines (empty unless the receipt waits for a moderator). */
  moderationReasons: string[];
  rejectionCode: ReceiptErrorCode | null;
  expectedPoints?: number | null;
}

export function toReceiptDetailDto(row: Receipt, parts: ReceiptDetailParts): ReceiptDetailDto {
  return {
    ...toReceiptDto(row, parts.tenant, parts.appeals.length, parts.expectedPoints ?? null),
    photoUrl: parts.photoUrl,
    moderationReasons: parts.moderationReasons,
    rejectionCode: parts.rejectionCode,
    points: parts.points,
    events: parts.events.map(toEventDto),
    appeals: parts.appeals.map(toAppealDto),
  };
}

export function toAdminReceiptDto(
  row: Receipt,
  tenant: ReceiptTenantDto | null,
  appealCount = 0,
  expectedPoints: number | null = null,
): AdminReceiptDto {
  return {
    ...toReceiptDto(row, tenant, appealCount, expectedPoints),
    userId: row.userId,
    deviceId: row.deviceId,
    riskFlags: parseRiskFlags(row.riskFlags),
    riskScore: row.riskScore,
    moderatorId: row.moderatorId,
    pointsTxId: row.pointsTxId,
    photoKey: row.photoKey,
    moderationReasons: parseModerationReasons(row.moderationReasons),
    rejectionCode: parseRejectionCode(row.rejectionCode),
    verification: row.verification,
    verifyUntil: iso(row.verifyUntil),
  };
}

export interface AdminReceiptDetailParts {
  tenant: ReceiptTenantDto | null;
  photoUrl: string | null;
  events: ReceiptEvent[];
  appeals: Array<{ appeal: ReceiptAppeal; photoUrl: string | null }>;
  expectedPoints?: number | null;
}

export function toAdminReceiptDetailDto(
  row: Receipt,
  parts: AdminReceiptDetailParts,
): AdminReceiptDetailDto {
  return {
    ...toAdminReceiptDto(row, parts.tenant, parts.appeals.length, parts.expectedPoints ?? null),
    rawQr: row.rawQr,
    fnRaw: row.fnRaw,
    fiscalIdRaw: row.fiscalIdRaw,
    photoUrl: parts.photoUrl,
    events: parts.events.map(toAdminEventDto),
    appeals: parts.appeals.map(({ appeal, photoUrl }) => toAdminAppealDto(appeal, photoUrl)),
  };
}
