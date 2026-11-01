import {
  Prisma,
  type Receipt,
  type ReceiptAppeal,
  type ReceiptEvent,
  type ReceiptVerification,
} from '@prisma/client';
import type { ReceiptStatus } from '../../../src/common/contracts/receipts';
import type { DateRange } from '../../../src/common/contracts/shared';
import type { Clock } from '../../../src/common/time/clock';
import type { FiscalIdPoint } from '../../../src/modules/receipts/domain/rules';
import type {
  AppealResolution,
  DeviceSharedQuery,
  FiscalIdNeighboursQuery,
  NewReceipt,
  NewReceiptAppeal,
  NewReceiptEvent,
  ReceiptListFilter,
  ReceiptPageQuery,
  ReceiptPatch,
  ReceiptsRepository,
  SameTotalQuery,
} from '../../../src/modules/receipts/services/receipts.repository';
import type { Snapshotable } from './fake-tx';

/** Same as COUNTED_FOR_PATTERNS in the repository: rejected receipts are ignored. */
const COUNTED_FOR_PATTERNS: readonly ReceiptStatus[] = [
  'uploaded',
  'parsed',
  'auto_approved',
  'needs_moderation',
  'approved',
  'credited',
  'appealed',
];

interface State {
  receipts: Receipt[];
  events: ReceiptEvent[];
  appeals: ReceiptAppeal[];
}

function cloneState(state: State): State {
  return {
    receipts: state.receipts.map((row) => ({ ...row })),
    events: state.events.map((row) => ({ ...row })),
    appeals: state.appeals.map((row) => ({ ...row })),
  };
}

function within(date: Date, from: Date, to: Date): boolean {
  return date.getTime() >= from.getTime() && date.getTime() < to.getTime();
}

function compareKey(a: Receipt, b: Receipt): number {
  const diff = a.submittedAt.getTime() - b.submittedAt.getTime();
  if (diff !== 0) {
    return diff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * In-memory stand-in for ReceiptsRepository (same method signatures, the db argument is
 * ignored). Implements the (fn, fiscalId) unique constraint with a Prisma P2002 error so the
 * services' duplicate handling is exercised, and supports transaction rollback via snapshots.
 */
export class InMemoryReceiptsRepository
  implements Pick<ReceiptsRepository, keyof ReceiptsRepository>, Snapshotable
{
  private state: State = { receipts: [], events: [], appeals: [] };
  /** Members whose advisory lock was taken (lockMember calls, in order). */
  readonly lockedMembers: string[] = [];

  constructor(private readonly clock: Clock) {}

  snapshot(): unknown {
    return cloneState(this.state);
  }

  restore(snapshot: unknown): void {
    this.state = cloneState(snapshot as State);
  }

  get receipts(): Receipt[] {
    return this.state.receipts;
  }

  get events(): ReceiptEvent[] {
    return this.state.events;
  }

  get appeals(): ReceiptAppeal[] {
    return this.state.appeals;
  }

  /** Test helper: inserts a row as is (e.g. older receipts for limits). */
  insert(row: Partial<Receipt> & Pick<Receipt, 'id' | 'userId' | 'fn' | 'fiscalId'>): Receipt {
    const now = this.clock.now();
    const full: Receipt = {
      deviceId: null,
      fnRaw: null,
      fiscalIdRaw: null,
      verification: 'not_required',
      verifyUntil: null,
      verificationCheckedAt: null,
      issuedAt: now,
      // Not a round total (round totals trigger round_total_repeat in the rules).
      totalKopecks: 10_050,
      rawQr: null,
      source: 'qr',
      photoKey: null,
      tenantId: null,
      status: 'credited',
      riskFlags: [],
      riskScore: 0,
      moderatorId: null,
      moderationReasons: [],
      rejectionCode: null,
      decisionReason: null,
      decidedAt: null,
      pointsAwarded: null,
      pointsTxId: null,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
      ...row,
    };
    this.state.receipts.push(full);
    return full;
  }

  /** PostgreSQL semantics of the (fn, fiscal_id) unique key: NULL fn never collides. */
  private assertUnique(fn: string | null, fiscalId: string, exceptId?: string): void {
    if (
      fn !== null &&
      this.state.receipts.some(
        (row) => row.id !== exceptId && row.fn === fn && row.fiscalId === fiscalId,
      )
    ) {
      throw new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`fn`,`fiscal_id`)',
        { code: 'P2002', clientVersion: 'test', meta: { target: ['fn', 'fiscal_id'] } },
      );
    }
  }

  async create(_db: unknown, data: NewReceipt): Promise<Receipt> {
    this.assertUnique(data.fn, data.fiscalId);
    const row: Receipt = {
      ...data,
      verification: 'not_required',
      verifyUntil: null,
      verificationCheckedAt: null,
      riskFlags: [...data.riskFlags],
      moderatorId: null,
      moderationReasons: [],
      rejectionCode: null,
      decisionReason: null,
      decidedAt: null,
      pointsAwarded: null,
      pointsTxId: null,
      updatedAt: this.clock.now(),
    };
    this.state.receipts.push(row);
    return { ...row };
  }

  async findById(_db: unknown, id: string): Promise<Receipt | null> {
    const row = this.state.receipts.find((receipt) => receipt.id === id);
    return row ? { ...row } : null;
  }

  async findByFnAndFiscalId(_db: unknown, fn: string, fiscalId: string): Promise<Receipt | null> {
    const row = this.state.receipts.find(
      (receipt) => receipt.fn === fn && receipt.fiscalId === fiscalId,
    );
    return row ? { ...row } : null;
  }

  async transitionStatus(
    _db: unknown,
    id: string,
    from: ReceiptStatus,
    patch: ReceiptPatch & { status: ReceiptStatus },
  ): Promise<Receipt | null> {
    const row = this.state.receipts.find((receipt) => receipt.id === id);
    if (!row || row.status !== from) {
      return null;
    }
    if (patch.fn !== undefined) {
      this.assertUnique(patch.fn, row.fiscalId, row.id);
    }
    const { riskFlags, moderationReasons, ...rest } = patch;
    Object.assign(row, rest);
    if (riskFlags !== undefined) {
      row.riskFlags = [...riskFlags];
    }
    if (moderationReasons !== undefined) {
      row.moderationReasons = [...moderationReasons];
    }
    row.updatedAt = this.clock.now();
    return { ...row };
  }

  async addEvent(_db: unknown, event: NewReceiptEvent): Promise<void> {
    this.state.events.push({ ...event });
  }

  async listEvents(_db: unknown, receiptId: string): Promise<ReceiptEvent[]> {
    return this.state.events
      .filter((event) => event.receiptId === receiptId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((event) => ({ ...event }));
  }

  async list(_db: unknown, filter: ReceiptListFilter, page: ReceiptPageQuery): Promise<Receipt[]> {
    const statuses =
      filter.status === undefined
        ? null
        : typeof filter.status === 'string'
          ? [filter.status]
          : [...filter.status];
    let rows = this.state.receipts.filter(
      (row) =>
        (filter.userId === undefined || row.userId === filter.userId) &&
        (statuses === null || statuses.includes(row.status)) &&
        (filter.fn === undefined || row.fn === filter.fn) &&
        (filter.moderationReason === undefined ||
          (Array.isArray(row.moderationReasons) &&
            row.moderationReasons.includes(filter.moderationReason))) &&
        (filter.from === undefined || row.submittedAt.getTime() >= filter.from.getTime()) &&
        (filter.to === undefined || row.submittedAt.getTime() < filter.to.getTime()),
    );
    rows = [...rows].sort(compareKey);
    if (page.order === 'desc') {
      rows.reverse();
    }
    const cursor = page.cursor;
    if (cursor) {
      const at = new Date(cursor.s).getTime();
      rows = rows.filter((row) => {
        const t = row.submittedAt.getTime();
        return page.order === 'desc'
          ? t < at || (t === at && row.id < cursor.id)
          : t > at || (t === at && row.id > cursor.id);
      });
    }
    return rows.slice(0, page.limit + 1).map((row) => ({ ...row }));
  }

  async countForUserBetween(
    _db: unknown,
    userId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<number> {
    return this.state.receipts.filter(
      (row) => row.userId === userId && within(row.submittedAt, from, to) && row.id !== excludeId,
    ).length;
  }

  async countForUserFromFnSince(
    _db: unknown,
    userId: string,
    fn: string,
    since: Date,
    excludeId?: string,
  ): Promise<number> {
    return this.state.receipts.filter(
      (row) =>
        row.userId === userId &&
        row.fn === fn &&
        row.submittedAt.getTime() >= since.getTime() &&
        row.id !== excludeId,
    ).length;
  }

  async hasOtherUserReceiptsForDevice(_db: unknown, query: DeviceSharedQuery): Promise<boolean> {
    return this.state.receipts.some(
      (row) =>
        row.id !== query.receiptId &&
        row.userId !== query.userId &&
        row.deviceId === query.deviceId &&
        row.submittedAt.getTime() >= query.since.getTime(),
    );
  }

  async lockMember(_tx: unknown, userId: string): Promise<void> {
    this.lockedMembers.push(userId);
  }

  async sumQrPointsForUserBetween(
    _db: unknown,
    userId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<number> {
    return this.state.receipts
      .filter(
        (row) =>
          row.userId === userId &&
          row.source === 'qr' &&
          row.status === 'credited' &&
          within(row.submittedAt, from, to) &&
          row.id !== excludeId,
      )
      .reduce((sum, row) => sum + (row.pointsAwarded ?? 0), 0);
  }

  async existsSameTotalFromOtherUser(_db: unknown, query: SameTotalQuery): Promise<boolean> {
    return this.state.receipts.some(
      (row) =>
        row.id !== query.receiptId &&
        row.userId !== query.userId &&
        row.fn === query.fn &&
        row.totalKopecks === query.totalKopecks &&
        row.submittedAt.getTime() >= query.since.getTime() &&
        COUNTED_FOR_PATTERNS.includes(row.status),
    );
  }

  async listTotalsForUserSince(
    _db: unknown,
    userId: string,
    since: Date,
    excludeId?: string,
  ): Promise<number[]> {
    return this.state.receipts
      .filter(
        (row) =>
          row.userId === userId &&
          row.submittedAt.getTime() >= since.getTime() &&
          COUNTED_FOR_PATTERNS.includes(row.status) &&
          row.id !== excludeId,
      )
      .map((row) => row.totalKopecks);
  }

  async listFiscalIdNeighbours(
    _db: unknown,
    query: FiscalIdNeighboursQuery,
  ): Promise<FiscalIdPoint[]> {
    const same = this.state.receipts.filter(
      (row) =>
        row.id !== query.receiptId &&
        row.fn === query.fn &&
        COUNTED_FOR_PATTERNS.includes(row.status),
    );
    const at = query.issuedAt.getTime();
    const before = same
      .filter((row) => row.issuedAt.getTime() < at)
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())
      .slice(0, query.limit);
    const after = same
      .filter((row) => row.issuedAt.getTime() > at)
      .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime())
      .slice(0, query.limit);
    return [...before, ...after].map((row) => ({ fiscalId: row.fiscalId, issuedAt: row.issuedAt }));
  }

  async listForUserByStatuses(
    _db: unknown,
    userId: string,
    statuses: readonly ReceiptStatus[],
    limit: number,
  ): Promise<Receipt[]> {
    return this.state.receipts
      .filter((row) => row.userId === userId && statuses.includes(row.status))
      .sort((a, b) => -compareKey(a, b))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async countForUserByStatuses(
    _db: unknown,
    userId: string,
    statuses: readonly ReceiptStatus[],
  ): Promise<number> {
    return this.state.receipts.filter(
      (row) => row.userId === userId && statuses.includes(row.status),
    ).length;
  }

  async listPendingVerification(_db: unknown, limit: number): Promise<Receipt[]> {
    const checked = (row: Receipt): number => row.verificationCheckedAt?.getTime() ?? -Infinity;
    return this.state.receipts
      .filter((row) => row.verification === 'pending' && row.status === 'credited')
      .sort((a, b) => checked(a) - checked(b) || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async updateVerification(
    _db: unknown,
    id: string,
    from: ReceiptVerification,
    patch: { verification: ReceiptVerification; verificationCheckedAt: Date },
  ): Promise<boolean> {
    const row = this.state.receipts.find((receipt) => receipt.id === id);
    if (!row || row.verification !== from) {
      return false;
    }
    Object.assign(row, patch);
    row.updatedAt = this.clock.now();
    return true;
  }

  async listStuck(
    _db: unknown,
    statuses: readonly ReceiptStatus[],
    updatedBefore: Date,
    limit: number,
  ): Promise<Array<Pick<Receipt, 'id' | 'status'>>> {
    return this.state.receipts
      .filter(
        (row) => statuses.includes(row.status) && row.updatedAt.getTime() < updatedBefore.getTime(),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map((row) => ({ id: row.id, status: row.status }));
  }

  async countCreditedForUser(_db: unknown, userId: string, excludeId?: string): Promise<number> {
    return this.state.receipts.filter(
      (row) => row.userId === userId && row.status === 'credited' && row.id !== excludeId,
    ).length;
  }

  async sumPointsForTenantBetween(
    _db: unknown,
    userId: string,
    tenantId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<number> {
    return this.state.receipts
      .filter(
        (row) =>
          row.userId === userId &&
          row.tenantId === tenantId &&
          row.status === 'credited' &&
          within(row.submittedAt, from, to) &&
          row.id !== excludeId,
      )
      .reduce((sum, row) => sum + (row.pointsAwarded ?? 0), 0);
  }

  async createAppeal(_db: unknown, data: NewReceiptAppeal): Promise<ReceiptAppeal> {
    const row: ReceiptAppeal = { ...data, resolvedAt: null, resolvedById: null, resolution: null };
    this.state.appeals.push(row);
    return { ...row };
  }

  async listAppeals(_db: unknown, receiptId: string): Promise<ReceiptAppeal[]> {
    return this.state.appeals
      .filter((appeal) => appeal.receiptId === receiptId)
      .map((appeal) => ({ ...appeal }));
  }

  async countAppeals(_db: unknown, receiptId: string): Promise<number> {
    return this.state.appeals.filter((appeal) => appeal.receiptId === receiptId).length;
  }

  async countAppealsByReceipt(
    _db: unknown,
    receiptIds: readonly string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const appeal of this.state.appeals) {
      if (receiptIds.includes(appeal.receiptId)) {
        result.set(appeal.receiptId, (result.get(appeal.receiptId) ?? 0) + 1);
      }
    }
    return result;
  }

  async resolveOpenAppeals(
    _db: unknown,
    receiptId: string,
    resolution: AppealResolution,
  ): Promise<number> {
    let count = 0;
    for (const appeal of this.state.appeals) {
      if (appeal.receiptId === receiptId && appeal.resolvedAt === null) {
        Object.assign(appeal, resolution);
        count += 1;
      }
    }
    return count;
  }

  async listPhotoKeysForUser(_db: unknown, userId: string): Promise<string[]> {
    const receiptIds = new Set(
      this.state.receipts.filter((row) => row.userId === userId).map((row) => row.id),
    );
    const keys = [
      ...this.state.receipts.filter((row) => receiptIds.has(row.id)).map((row) => row.photoKey),
      ...this.state.appeals
        .filter((appeal) => receiptIds.has(appeal.receiptId))
        .map((appeal) => appeal.photoKey),
    ].filter((key): key is string => key !== null);
    return [...new Set(keys)];
  }

  async erasePersonalData(
    _db: unknown,
    userId: string,
    appealPlaceholder: string,
  ): Promise<{ receipts: number; appeals: number }> {
    let receipts = 0;
    let appeals = 0;
    const receiptIds = new Set<string>();
    for (const row of this.state.receipts) {
      if (row.userId !== userId) {
        continue;
      }
      receiptIds.add(row.id);
      if (row.photoKey !== null) {
        row.photoKey = null;
        row.updatedAt = this.clock.now();
        receipts += 1;
      }
    }
    for (const appeal of this.state.appeals) {
      if (
        receiptIds.has(appeal.receiptId) &&
        (appeal.photoKey !== null || appeal.message !== appealPlaceholder)
      ) {
        appeal.photoKey = null;
        appeal.message = appealPlaceholder;
        appeals += 1;
      }
    }
    return { receipts, appeals };
  }

  async countBetween(_db: unknown, range: DateRange): Promise<number> {
    return this.state.receipts.filter((row) => within(row.submittedAt, range.from, range.to))
      .length;
  }

  async countByStatusBetween(
    _db: unknown,
    range: DateRange,
  ): Promise<Partial<Record<ReceiptStatus, number>>> {
    const result: Partial<Record<ReceiptStatus, number>> = {};
    for (const row of this.state.receipts) {
      if (within(row.submittedAt, range.from, range.to)) {
        result[row.status] = (result[row.status] ?? 0) + 1;
      }
    }
    return result;
  }

  async sumPointsBetween(_db: unknown, range: DateRange): Promise<number> {
    return this.state.receipts
      .filter((row) => row.status === 'credited' && within(row.submittedAt, range.from, range.to))
      .reduce((sum, row) => sum + (row.pointsAwarded ?? 0), 0);
  }
}
