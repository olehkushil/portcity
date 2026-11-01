import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import type {
  ParkingDailyStats,
  ParkingPort,
  ParkingQuote,
  ParkingSessionStatus,
  ParkingSessionSummary,
  ParkingTariffConfig,
  QuoteInput,
} from '../../../common/contracts/parking';
import type { DateRange } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ParkingErrors } from '../domain/errors';
import {
  ACTIVE_SESSION_STATUSES,
  CLOSE_REASONS,
  FINAL_SESSION_STATUSES,
  isFinalStatus,
} from '../domain/session-state';
import { type SessionRecord, type SessionView, buildSessionView } from '../domain/session-view';
import { SessionSyncService } from './session-sync.service';
import { TariffService } from './tariff.service';

export interface AdminSessionFilter {
  status?: ParkingSessionStatus;
  plate?: string;
  userId?: string;
  /** true: only disputed sessions (F2 «Це не моє авто»), false: only undisputed ones. */
  disputed?: boolean;
  cursor?: string;
  limit: number;
}

interface AdminCursor {
  e: string;
  i: string;
  [key: string]: string;
}

function isAdminCursor(value: unknown): value is AdminCursor {
  const candidate = value as Partial<AdminCursor> | null;
  return !!candidate && typeof candidate.e === 'string' && typeof candidate.i === 'string';
}

/**
 * PARKING_PORT for other modules (rewards, notifications, admin) plus the back-office session
 * tools. Active sessions are re-derived at the current time, so consumers see current amounts.
 */
@Injectable()
export class ParkingService implements ParkingPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly tariffs: TariffService,
    private readonly sync: SessionSyncService,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async getSessionForUser(userId: string): Promise<ParkingSessionSummary | null> {
    const rows = await this.prisma.parkingSession.findMany({
      // A disputed session («Це не моє авто») is not the member's car.
      where: { userId, disputedAt: null, status: { in: ACTIVE_SESSION_STATUSES } },
      orderBy: { enteredAt: 'desc' },
      take: 5,
    });
    const preferred = rows.find((row) => row.source === 'provider') ?? rows[0] ?? null;
    return preferred ? this.summary(preferred) : null;
  }

  async getSession(sessionId: string): Promise<ParkingSessionSummary | null> {
    const row = await this.prisma.parkingSession.findUnique({ where: { id: sessionId } });
    return row ? this.summary(row) : null;
  }

  async quote(input: QuoteInput): Promise<ParkingQuote> {
    return this.tariffs.quote(input);
  }

  async getActiveTariff(at?: Date): Promise<{ version: number; config: ParkingTariffConfig }> {
    return this.tariffs.getActiveTariff(at ?? this.clock.now());
  }

  async getDailyStats(range: DateRange): Promise<ParkingDailyStats> {
    const window = { gte: range.from, lt: range.to };
    const [opened, closed, paid] = await Promise.all([
      this.prisma.parkingSession.count({ where: { enteredAt: window } }),
      this.prisma.parkingSession.count({
        where: { exitedAt: window, status: { in: [...FINAL_SESSION_STATUSES] } },
      }),
      this.prisma.parkingSession.aggregate({
        where: { exitedAt: window, source: 'provider' },
        _sum: { amountPaidKopecks: true },
      }),
    ]);
    return { opened, closed, paidKopecks: paid._sum.amountPaidKopecks ?? 0 };
  }

  // --- back office ------------------------------------------------------------------------------

  async listForAdmin(filter: AdminSessionFilter): Promise<Page<SessionView>> {
    const cursor = decodeCursor(filter.cursor, isAdminCursor);
    const rows = await this.prisma.parkingSession.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.plate ? { plate: filter.plate } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.disputed === true ? { disputedAt: { not: null } } : {}),
        ...(filter.disputed === false ? { disputedAt: null } : {}),
        ...(cursor
          ? {
              OR: [
                { enteredAt: { lt: new Date(cursor.e) } },
                { enteredAt: new Date(cursor.e), id: { lt: cursor.i } },
              ],
            }
          : {}),
      },
      orderBy: [{ enteredAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
    });
    const now = this.clock.now();
    const { config } = await this.tariffs.getActiveTariff(now);
    const page = toPage(rows, filter.limit, (last) => ({
      e: last.enteredAt.toISOString(),
      i: last.id,
    }));
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((row) => buildSessionView(row, { now, tariff: config })),
    };
  }

  /**
   * Closes a session free of charge (`closed_free`): a privilege granted by the operator or a
   * manual air-raid correction. Audited.
   */
  async closeFree(
    sessionId: string,
    input: { reason: 'privilege' | 'air_raid'; note?: string | null },
    actor: { id: string; ip?: string | null },
  ): Promise<SessionView> {
    const record = await this.prisma.parkingSession.findUnique({ where: { id: sessionId } });
    if (!record) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_SESSION_NOT_FOUND,
        'Parking session not found',
        {
          details: { sessionId },
        },
      );
    }
    if (isFinalStatus(record.status)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'The parking session is already closed',
        { details: { sessionId, status: record.status } },
      );
    }
    const reason = input.reason === 'air_raid' ? CLOSE_REASONS.airRaid : CLOSE_REASONS.privilege;
    const result = await this.sync.updateFacts(record, {
      exitedAt: this.clock.now(),
      closedReason: reason,
    });
    const updated = result.record ?? record;
    await this.audit.audit({
      actor: { type: 'admin', id: actor.id },
      action: 'parking_session.close_free',
      entityType: 'parking_session',
      entityId: record.id,
      before: { status: record.status, amountDueKopecks: record.amountDueKopecks },
      after: { status: updated.status, closedReason: updated.closedReason },
      reason: input.note ?? input.reason,
      ip: actor.ip ?? null,
    });
    const { config } = await this.tariffs.getActiveTariff(this.clock.now());
    return buildSessionView(updated, { now: this.clock.now(), tariff: config });
  }

  private async summary(row: SessionRecord): Promise<ParkingSessionSummary> {
    const now = this.clock.now();
    const { config } = await this.tariffs.getActiveTariff(now);
    const view = buildSessionView(row, { now, tariff: config });
    return {
      id: row.id,
      userId: row.userId,
      vehicleId: row.vehicleId,
      plate: row.plate,
      zone: row.zone,
      enteredAt: row.enteredAt,
      exitedAt: row.exitedAt,
      status: view.status,
      paidUntil: row.paidUntil,
      amountDueKopecks: view.amountDueKopecks,
      amountPaidKopecks: row.amountPaidKopecks,
      source: row.source,
      lastSyncedAt: row.lastSyncedAt,
    };
  }
}
