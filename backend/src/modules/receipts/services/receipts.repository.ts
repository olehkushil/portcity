import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type Receipt,
  type ReceiptAppeal,
  type ReceiptEvent,
  type ReceiptVerification,
} from '@prisma/client';
import type { ReceiptSource, ReceiptStatus, RiskFlag } from '../../../common/contracts/receipts';
import type { ActorType, DateRange } from '../../../common/contracts/shared';
import type { DbClient, Tx } from '../../../common/prisma/prisma.service';
import type { FiscalIdPoint } from '../domain/rules';

export interface NewReceipt {
  id: string;
  userId: string;
  deviceId: string | null;
  /** Canonical; null only for a manual receipt with a tenant but without the cash register. */
  fn: string | null;
  /** Canonical receipt number. */
  fiscalId: string;
  /** As submitted, for audit. */
  fnRaw: string | null;
  fiscalIdRaw: string | null;
  issuedAt: Date;
  totalKopecks: number;
  rawQr: string | null;
  source: ReceiptSource;
  photoKey: string | null;
  tenantId: string | null;
  status: ReceiptStatus;
  riskFlags: RiskFlag[];
  riskScore: number;
  submittedAt: Date;
  createdAt: Date;
}

export interface ReceiptPatch {
  status?: ReceiptStatus;
  /** Canonical fn filled in by a moderator (manual receipts submitted without it). */
  fn?: string;
  fnRaw?: string | null;
  tenantId?: string | null;
  verification?: ReceiptVerification;
  verifyUntil?: Date | null;
  verificationCheckedAt?: Date | null;
  riskFlags?: RiskFlag[];
  riskScore?: number;
  /** ModerationReason values (receipts.moderation_reasons). */
  moderationReasons?: readonly string[];
  /** Rule rejection code (receipts.rejection_code); null for moderator decisions. */
  rejectionCode?: string | null;
  moderatorId?: string | null;
  decisionReason?: string | null;
  decidedAt?: Date | null;
  pointsAwarded?: number | null;
  pointsTxId?: string | null;
}

export interface NewReceiptEvent {
  id: string;
  receiptId: string;
  fromStatus: ReceiptStatus | null;
  toStatus: ReceiptStatus;
  actorType: ActorType;
  actorId: string | null;
  note: string | null;
  createdAt: Date;
}

export interface NewReceiptAppeal {
  id: string;
  receiptId: string;
  message: string;
  photoKey: string | null;
  createdAt: Date;
}

export interface AppealResolution {
  resolvedById: string | null;
  resolution: string;
  resolvedAt: Date;
}

export interface ReceiptListFilter {
  userId?: string;
  status?: ReceiptStatus | readonly ReceiptStatus[];
  fn?: string;
  /** Receipts whose moderation_reasons contain this reason. */
  moderationReason?: string;
  /** submittedAt >= from */
  from?: Date;
  /** submittedAt < to */
  to?: Date;
}

/** Keyset cursor: submittedAt (ISO) and id of the last returned row. */
export type ReceiptCursor = { s: string; id: string };

export interface ReceiptPageQuery {
  cursor?: ReceiptCursor;
  /** The repository fetches `limit + 1` rows so the caller can detect a next page. */
  limit: number;
  order: 'asc' | 'desc';
}

export interface DeviceSharedQuery {
  /** The receipt being evaluated (excluded from the search). */
  receiptId: string;
  userId: string;
  deviceId: string;
  since: Date;
}

export interface SameTotalQuery {
  /** The receipt being evaluated (excluded from the search). */
  receiptId: string;
  userId: string;
  fn: string;
  totalKopecks: number;
  since: Date;
}

/** Receipts (from any member) whose numbers are compared for `fiscal_id_out_of_order`. */
export interface FiscalIdNeighboursQuery {
  receiptId: string;
  fn: string;
  issuedAt: Date;
  /** Per side (issued before / after). */
  limit: number;
}

/** Statuses in which a rejected receipt or a moderator decision no longer counts. */
const COUNTED_FOR_PATTERNS: readonly ReceiptStatus[] = [
  'uploaded',
  'parsed',
  'auto_approved',
  'needs_moderation',
  'approved',
  'credited',
  'appealed',
];

export function isReceiptCursor(value: unknown): value is ReceiptCursor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { s?: unknown; id?: unknown };
  return (
    typeof candidate.s === 'string' &&
    !Number.isNaN(Date.parse(candidate.s)) &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0
  );
}

/**
 * Prisma access to the receipts tables (receipts, receipt_events, receipt_appeals).
 * Every method takes the client or an open transaction first, so services compose them inside
 * `withTx`. Stateless on purpose: unit tests substitute an in-memory implementation.
 */
@Injectable()
export class ReceiptsRepository {
  async create(db: DbClient, data: NewReceipt): Promise<Receipt> {
    return db.receipt.create({
      data: {
        ...data,
        riskFlags: [...data.riskFlags],
      },
    });
  }

  async findById(db: DbClient, id: string): Promise<Receipt | null> {
    return db.receipt.findUnique({ where: { id } });
  }

  /** Lookup by the canonical unique key; pass canonical values only. */
  async findByFnAndFiscalId(db: DbClient, fn: string, fiscalId: string): Promise<Receipt | null> {
    return db.receipt.findUnique({ where: { fn_fiscalId: { fn, fiscalId } } });
  }

  /**
   * Optimistic status change: the row is updated only while it is still in `from`.
   * Returns null when another transaction moved it first.
   */
  async transitionStatus(
    db: DbClient,
    id: string,
    from: ReceiptStatus,
    patch: ReceiptPatch & { status: ReceiptStatus },
  ): Promise<Receipt | null> {
    const result = await db.receipt.updateMany({
      where: { id, status: from },
      data: toUpdateData(patch),
    });
    if (result.count !== 1) {
      return null;
    }
    return db.receipt.findUnique({ where: { id } });
  }

  async addEvent(db: DbClient, event: NewReceiptEvent): Promise<void> {
    await db.receiptEvent.create({ data: event });
  }

  async listEvents(db: DbClient, receiptId: string): Promise<ReceiptEvent[]> {
    return db.receiptEvent.findMany({
      where: { receiptId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async list(db: DbClient, filter: ReceiptListFilter, page: ReceiptPageQuery): Promise<Receipt[]> {
    const where: Prisma.ReceiptWhereInput = {};
    if (filter.userId !== undefined) {
      where.userId = filter.userId;
    }
    if (filter.status !== undefined) {
      where.status = typeof filter.status === 'string' ? filter.status : { in: [...filter.status] };
    }
    if (filter.fn !== undefined) {
      where.fn = filter.fn;
    }
    if (filter.moderationReason !== undefined) {
      where.moderationReasons = { array_contains: [filter.moderationReason] };
    }
    if (filter.from !== undefined || filter.to !== undefined) {
      where.submittedAt = {
        ...(filter.from !== undefined ? { gte: filter.from } : {}),
        ...(filter.to !== undefined ? { lt: filter.to } : {}),
      };
    }
    if (page.cursor) {
      const at = new Date(page.cursor.s);
      where.AND =
        page.order === 'desc'
          ? [{ OR: [{ submittedAt: { lt: at } }, { submittedAt: at, id: { lt: page.cursor.id } }] }]
          : [
              {
                OR: [{ submittedAt: { gt: at } }, { submittedAt: at, id: { gt: page.cursor.id } }],
              },
            ];
    }
    return db.receipt.findMany({
      where,
      orderBy: [{ submittedAt: page.order }, { id: page.order }],
      take: page.limit + 1,
    });
  }

  /** Receipts a member submitted in [from, to), optionally ignoring one row. */
  async countForUserBetween(
    db: DbClient,
    userId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<number> {
    return db.receipt.count({
      where: {
        userId,
        submittedAt: { gte: from, lt: to },
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
    });
  }

  /** Receipts from one cash register by one member since `since` (burst detection). */
  async countForUserFromFnSince(
    db: DbClient,
    userId: string,
    fn: string,
    since: Date,
    excludeId?: string,
  ): Promise<number> {
    return db.receipt.count({
      where: {
        userId,
        fn,
        submittedAt: { gte: since },
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
    });
  }

  /**
   * True when another member submitted a receipt from the same device since `since`.
   * Only the receipts table is read (brief section 3); fingerprint matching across reinstalls
   * would need an identity port method (README, open questions).
   */
  async hasOtherUserReceiptsForDevice(db: DbClient, query: DeviceSharedQuery): Promise<boolean> {
    const row = await db.receipt.findFirst({
      where: {
        id: { not: query.receiptId },
        userId: { not: query.userId },
        deviceId: query.deviceId,
        submittedAt: { gte: query.since },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Serialises the money-relevant part of crediting per member: a transaction-scoped advisory
   * lock on hashtext(userId), so daily caps and the first-receipt flag are computed after every
   * concurrent credit of the same member has committed. Released at commit or rollback.
   */
  async lockMember(tx: Tx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${userId}::text))) AS l`;
  }

  /** Points credited to a member for QR receipts submitted in [from, to) (daily QR cap). */
  async sumQrPointsForUserBetween(
    db: DbClient,
    userId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<number> {
    const result = await db.receipt.aggregate({
      where: {
        userId,
        source: 'qr',
        status: 'credited',
        submittedAt: { gte: from, lt: to },
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
      _sum: { pointsAwarded: true },
    });
    return result._sum.pointsAwarded ?? 0;
  }

  /** `same_total_other_user`: another member sent the same total from the same fn since `since`. */
  async existsSameTotalFromOtherUser(db: DbClient, query: SameTotalQuery): Promise<boolean> {
    const row = await db.receipt.findFirst({
      where: {
        id: { not: query.receiptId },
        userId: { not: query.userId },
        fn: query.fn,
        totalKopecks: query.totalKopecks,
        submittedAt: { gte: query.since },
        status: { in: [...COUNTED_FOR_PATTERNS] },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** Totals of a member's receipts submitted since `since` (round-total repeats). */
  async listTotalsForUserSince(
    db: DbClient,
    userId: string,
    since: Date,
    excludeId?: string,
  ): Promise<number[]> {
    const rows = await db.receipt.findMany({
      where: {
        userId,
        submittedAt: { gte: since },
        status: { in: [...COUNTED_FOR_PATTERNS] },
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
      take: 500,
      select: { totalKopecks: true },
    });
    return rows.map((row) => row.totalKopecks);
  }

  /** The nearest receipts of one cash register issued before and after `issuedAt`. */
  async listFiscalIdNeighbours(
    db: DbClient,
    query: FiscalIdNeighboursQuery,
  ): Promise<FiscalIdPoint[]> {
    const base: Prisma.ReceiptWhereInput = {
      id: { not: query.receiptId },
      fn: query.fn,
      status: { in: [...COUNTED_FOR_PATTERNS] },
    };
    const select = { fiscalId: true, issuedAt: true } as const;
    const [before, after] = await Promise.all([
      db.receipt.findMany({
        where: { ...base, issuedAt: { lt: query.issuedAt } },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        select,
      }),
      db.receipt.findMany({
        where: { ...base, issuedAt: { gt: query.issuedAt } },
        orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
        take: query.limit,
        select,
      }),
    ]);
    return [...before, ...after];
  }

  /** A member's receipts in the given statuses, newest first (pending summary, estimates). */
  async listForUserByStatuses(
    db: DbClient,
    userId: string,
    statuses: readonly ReceiptStatus[],
    limit: number,
  ): Promise<Receipt[]> {
    return db.receipt.findMany({
      where: { userId, status: { in: [...statuses] } },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  async countForUserByStatuses(
    db: DbClient,
    userId: string,
    statuses: readonly ReceiptStatus[],
  ): Promise<number> {
    return db.receipt.count({ where: { userId, status: { in: [...statuses] } } });
  }

  /** Credited receipts still in their verification hold, least recently checked first. */
  async listPendingVerification(db: DbClient, limit: number): Promise<Receipt[]> {
    return db.receipt.findMany({
      where: { verification: 'pending', status: 'credited' },
      orderBy: [{ verificationCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: limit,
    });
  }

  /** Optimistic change of the verification columns (status untouched); false when moved. */
  async updateVerification(
    db: DbClient,
    id: string,
    from: ReceiptVerification,
    patch: { verification: ReceiptVerification; verificationCheckedAt: Date },
  ): Promise<boolean> {
    const result = await db.receipt.updateMany({ where: { id, verification: from }, data: patch });
    return result.count === 1;
  }

  /** Receipts the pipeline has not finished (sweep of the receipts-process queue). */
  async listStuck(
    db: DbClient,
    statuses: readonly ReceiptStatus[],
    updatedBefore: Date,
    limit: number,
  ): Promise<Array<Pick<Receipt, 'id' | 'status'>>> {
    return db.receipt.findMany({
      where: { status: { in: [...statuses] }, updatedAt: { lt: updatedBefore } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, status: true },
    });
  }

  async countCreditedForUser(db: DbClient, userId: string, excludeId?: string): Promise<number> {
    return db.receipt.count({
      where: {
        userId,
        status: 'credited',
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
    });
  }

  /** Points already awarded to a member for one tenant in [from, to) (tenant daily cap). */
  async sumPointsForTenantBetween(
    db: DbClient,
    userId: string,
    tenantId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<number> {
    const result = await db.receipt.aggregate({
      where: {
        userId,
        tenantId,
        status: 'credited',
        submittedAt: { gte: from, lt: to },
        ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
      },
      _sum: { pointsAwarded: true },
    });
    return result._sum.pointsAwarded ?? 0;
  }

  async createAppeal(db: DbClient, data: NewReceiptAppeal): Promise<ReceiptAppeal> {
    return db.receiptAppeal.create({ data });
  }

  async listAppeals(db: DbClient, receiptId: string): Promise<ReceiptAppeal[]> {
    return db.receiptAppeal.findMany({
      where: { receiptId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async countAppeals(db: DbClient, receiptId: string): Promise<number> {
    return db.receiptAppeal.count({ where: { receiptId } });
  }

  /** Appeal counts for a page of receipts (receipts without appeals are omitted). */
  async countAppealsByReceipt(
    db: DbClient,
    receiptIds: readonly string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (receiptIds.length === 0) {
      return result;
    }
    const rows = await db.receiptAppeal.groupBy({
      by: ['receiptId'],
      where: { receiptId: { in: [...receiptIds] } },
      _count: { _all: true },
    });
    for (const row of rows) {
      result.set(row.receiptId, row._count._all);
    }
    return result;
  }

  async resolveOpenAppeals(
    db: DbClient,
    receiptId: string,
    resolution: AppealResolution,
  ): Promise<number> {
    const result = await db.receiptAppeal.updateMany({
      where: { receiptId, resolvedAt: null },
      data: resolution,
    });
    return result.count;
  }

  /** Photo objects of a member's receipts and appeals (account erasure, user.deleted). */
  async listPhotoKeysForUser(db: DbClient, userId: string): Promise<string[]> {
    const [receipts, appeals] = await Promise.all([
      db.receipt.findMany({
        where: { userId, photoKey: { not: null } },
        select: { photoKey: true },
      }),
      db.receiptAppeal.findMany({
        where: { receipt: { userId }, photoKey: { not: null } },
        select: { photoKey: true },
      }),
    ]);
    const keys = [...receipts, ...appeals]
      .map((row) => row.photoKey)
      .filter((key): key is string => key !== null);
    return [...new Set(keys)];
  }

  /**
   * Account erasure: drops photo keys and appeal texts of a member's receipts. Fiscal data
   * (fn, fiscalId, totals, rawQr) stays for duplicate detection and accounting.
   */
  async erasePersonalData(
    db: DbClient,
    userId: string,
    appealPlaceholder: string,
  ): Promise<{ receipts: number; appeals: number }> {
    const receipts = await db.receipt.updateMany({
      where: { userId, photoKey: { not: null } },
      data: { photoKey: null },
    });
    const appeals = await db.receiptAppeal.updateMany({
      where: {
        receipt: { userId },
        OR: [{ photoKey: { not: null } }, { message: { not: appealPlaceholder } }],
      },
      data: { photoKey: null, message: appealPlaceholder },
    });
    return { receipts: receipts.count, appeals: appeals.count };
  }

  async countBetween(db: DbClient, range: DateRange): Promise<number> {
    return db.receipt.count({ where: { submittedAt: { gte: range.from, lt: range.to } } });
  }

  async countByStatusBetween(
    db: DbClient,
    range: DateRange,
  ): Promise<Partial<Record<ReceiptStatus, number>>> {
    const rows = await db.receipt.groupBy({
      by: ['status'],
      where: { submittedAt: { gte: range.from, lt: range.to } },
      _count: { _all: true },
    });
    const result: Partial<Record<ReceiptStatus, number>> = {};
    for (const row of rows) {
      result[row.status] = row._count._all;
    }
    return result;
  }

  /** Points awarded for receipts submitted in the range and credited so far. */
  async sumPointsBetween(db: DbClient, range: DateRange): Promise<number> {
    const result = await db.receipt.aggregate({
      where: { status: 'credited', submittedAt: { gte: range.from, lt: range.to } },
      _sum: { pointsAwarded: true },
    });
    return result._sum.pointsAwarded ?? 0;
  }
}

function toUpdateData(patch: ReceiptPatch): Prisma.ReceiptUncheckedUpdateManyInput {
  const data: Prisma.ReceiptUncheckedUpdateManyInput = {};
  if (patch.status !== undefined) {
    data.status = patch.status;
  }
  if (patch.fn !== undefined) {
    data.fn = patch.fn;
  }
  if (patch.fnRaw !== undefined) {
    data.fnRaw = patch.fnRaw;
  }
  if (patch.tenantId !== undefined) {
    data.tenantId = patch.tenantId;
  }
  if (patch.verification !== undefined) {
    data.verification = patch.verification;
  }
  if (patch.verifyUntil !== undefined) {
    data.verifyUntil = patch.verifyUntil;
  }
  if (patch.verificationCheckedAt !== undefined) {
    data.verificationCheckedAt = patch.verificationCheckedAt;
  }
  if (patch.riskFlags !== undefined) {
    data.riskFlags = [...patch.riskFlags];
  }
  if (patch.riskScore !== undefined) {
    data.riskScore = patch.riskScore;
  }
  if (patch.moderationReasons !== undefined) {
    data.moderationReasons = [...patch.moderationReasons];
  }
  if (patch.rejectionCode !== undefined) {
    data.rejectionCode = patch.rejectionCode;
  }
  if (patch.moderatorId !== undefined) {
    data.moderatorId = patch.moderatorId;
  }
  if (patch.decisionReason !== undefined) {
    data.decisionReason = patch.decisionReason;
  }
  if (patch.decidedAt !== undefined) {
    data.decidedAt = patch.decidedAt;
  }
  if (patch.pointsAwarded !== undefined) {
    data.pointsAwarded = patch.pointsAwarded;
  }
  if (patch.pointsTxId !== undefined) {
    data.pointsTxId = patch.pointsTxId;
  }
  return data;
}
