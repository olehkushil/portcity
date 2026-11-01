import { Inject, Injectable, Logger } from '@nestjs/common';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../../common/contracts/club';
import { PARKING_PORT, type ParkingPort } from '../../../common/contracts/parking';
import { RECEIPTS_PORT, type ReceiptsPort } from '../../../common/contracts/receipts';
import { VOUCHER_ISSUER_PORT, type VoucherIssuerPort } from '../../../common/contracts/rewards';
import { DomainError } from '../../../common/errors/domain-error';
import { toJsonValue } from '../../../common/idempotency/idempotency.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import {
  type DailyReport,
  type ReportSection,
  type ReportSource,
  assertDayKey,
  buildDailyReport,
  dayKeyToDate,
  dayKeysBetween,
  isDailyReport,
  kyivDayRange,
  previousKyivDay,
  summariseAdjustments,
} from '../domain/daily-report';
import { AdminErrors } from '../domain/errors';
import type { AdminActor } from '../domain/views';

function errorCodeOf(error: unknown): string {
  if (DomainError.is(error)) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name || 'Error';
  }
  return 'UNKNOWN';
}

/**
 * Daily reports (brief sections 8 and 9): computed from the statistics ports of receipts, club,
 * rewards and parking plus the module's own manual adjustments, stored in `daily_stats` by the
 * reports-nightly job or on demand. A failing source does not fail the report: its section is
 * null and listed in `errors`.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(RECEIPTS_PORT) private readonly receipts: ReceiptsPort,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
    @Inject(VOUCHER_ISSUER_PORT) private readonly vouchers: VoucherIssuerPort,
    @Inject(PARKING_PORT) private readonly parking: ParkingPort,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  /** Stored report for `day` (default: yesterday in Kyiv); 404 PC_REPORT_NOT_READY when absent. */
  async getStored(day?: string): Promise<DailyReport> {
    const target = day ?? previousKyivDay(this.clock.now());
    assertDayKey(target);
    const row = await this.prisma.dailyStat.findUnique({ where: { day: dayKeyToDate(target) } });
    if (!row || !isDailyReport(row.stats)) {
      throw new DomainError(
        AdminErrors.PC_REPORT_NOT_READY,
        `No daily report is stored for ${target}: the reports-nightly job runs after midnight Kyiv, or recompute it with POST /admin/reports/daily/recompute`,
        { details: { day: target } },
      );
    }
    return row.stats;
  }

  /** Stored reports between `from` and `to` (inclusive, at most MAX_REPORT_RANGE_DAYS days). */
  async listStored(from: string, to: string): Promise<DailyReport[]> {
    dayKeysBetween(from, to);
    const rows = await this.prisma.dailyStat.findMany({
      where: { day: { gte: dayKeyToDate(from), lte: dayKeyToDate(to) } },
      orderBy: { day: 'asc' },
    });
    const reports: DailyReport[] = [];
    for (const row of rows) {
      if (isDailyReport(row.stats)) {
        reports.push(row.stats);
      }
    }
    return reports;
  }

  async hasStored(day: string): Promise<boolean> {
    assertDayKey(day);
    const count = await this.prisma.dailyStat.count({ where: { day: dayKeyToDate(day) } });
    return count > 0;
  }

  /** Computes the report without storing it. */
  async compute(day: string, source: ReportSource): Promise<DailyReport> {
    assertDayKey(day);
    const range = kyivDayRange(day);
    const errors: Partial<Record<ReportSection, string>> = {};
    const [receipts, points, vouchers, parking] = await Promise.all([
      this.section('receipts', errors, () => this.receipts.getDailyStats(range)),
      this.section('points', errors, () => this.ledger.getDailyStats(range)),
      this.section('vouchers', errors, () => this.vouchers.getDailyStats(range)),
      this.section('parking', errors, () => this.parking.getDailyStats(range)),
    ]);
    const window = { gte: range.from, lt: range.to };
    const adjustmentRows = await this.prisma.manualAdjustment.findMany({
      where: { OR: [{ createdAt: window }, { decidedAt: window }, { appliedAt: window }] },
      select: { status: true, amount: true, createdAt: true, decidedAt: true, appliedAt: true },
    });
    return buildDailyReport({
      day,
      range,
      sections: { receipts, points, vouchers, parking },
      adjustments: summariseAdjustments(adjustmentRows, range),
      errors,
      source,
      computedAt: this.clock.now(),
    });
  }

  /** Computes and upserts the `daily_stats` row (used by the nightly job and recompute). */
  async computeAndStore(day: string, source: ReportSource): Promise<DailyReport> {
    const report = await this.compute(day, source);
    const dayDate = dayKeyToDate(day);
    const computedAt = new Date(report.computedAt);
    const stats = toJsonValue(report);
    await this.prisma.dailyStat.upsert({
      where: { day: dayDate },
      create: { day: dayDate, stats, computedAt },
      update: { stats, computedAt },
    });
    return report;
  }

  /** Admin-triggered recomputation (audited). `day` defaults to yesterday in Kyiv. */
  async recompute(day: string | undefined, actor: AdminActor): Promise<DailyReport> {
    const target = day ?? previousKyivDay(this.clock.now());
    assertDayKey(target);
    const report = await this.computeAndStore(target, 'manual');
    await this.audit.audit({
      actor: { type: 'admin', id: actor.id },
      action: 'daily_stat.recompute',
      entityType: 'daily_stat',
      entityId: target,
      after: {
        complete: report.complete,
        dayClosed: report.dayClosed,
        errors: report.errors,
        computedAt: report.computedAt,
      },
      ip: actor.ip ?? null,
    });
    return report;
  }

  private async section<T>(
    name: ReportSection,
    errors: Partial<Record<ReportSection, string>>,
    load: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      const code = errorCodeOf(error);
      errors[name] = code;
      this.logger.warn(`Daily report section "${name}" failed: ${code}`);
      return null;
    }
  }
}
