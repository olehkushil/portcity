import type { AdminAuditPort, AuditEntry } from '../../../common/contracts/admin';
import type { ClubLedgerPort } from '../../../common/contracts/club';
import type { ParkingPort } from '../../../common/contracts/parking';
import type { ReceiptsPort } from '../../../common/contracts/receipts';
import type { VoucherIssuerPort } from '../../../common/contracts/rewards';
import type { DateRange } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { ReportsService } from './reports.service';

interface StatRow {
  day: Date;
  stats: unknown;
  computedAt: Date;
}

interface AdjustmentRow {
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  amount: number;
  createdAt: Date;
  decidedAt: Date | null;
  appliedAt: Date | null;
}

class FakePrisma {
  readonly stats = new Map<string, StatRow>();
  adjustments: AdjustmentRow[] = [];

  readonly dailyStat = {
    findUnique: async (args: { where: { day: Date } }) =>
      this.stats.get(args.where.day.toISOString()) ?? null,
    findMany: async (args: { where: { day: { gte: Date; lte: Date } } }) =>
      [...this.stats.values()]
        .filter(
          (row) =>
            row.day.getTime() >= args.where.day.gte.getTime() &&
            row.day.getTime() <= args.where.day.lte.getTime(),
        )
        .sort((a, b) => a.day.getTime() - b.day.getTime()),
    count: async (args: { where: { day: Date } }) =>
      this.stats.has(args.where.day.toISOString()) ? 1 : 0,
    upsert: async (args: {
      where: { day: Date };
      create: StatRow;
      update: Omit<StatRow, 'day'>;
    }) => {
      const key = args.where.day.toISOString();
      const existing = this.stats.get(key);
      const row = existing ? { ...existing, ...args.update } : args.create;
      this.stats.set(key, row);
      return row;
    },
  };

  readonly manualAdjustment = {
    findMany: jest.fn(async () => this.adjustments),
  };
}

function setup(options: { parkingFails?: boolean } = {}) {
  const prisma = new FakePrisma();
  const clock = new FakeClock('2026-01-15T10:00:00.000Z');
  const ranges: DateRange[] = [];
  const receipts = {
    getReceipt: jest.fn(),
    countForUser: jest.fn(),
    getDailyStats: jest.fn(async (range: DateRange) => {
      ranges.push(range);
      return { submitted: 12, byStatus: { credited: 9, needs_moderation: 3 }, pointsAwarded: 540 };
    }),
  } as unknown as ReceiptsPort;
  const ledger = {
    getDailyStats: jest.fn(async () => ({ earned: 540, spent: 120, expired: 0, reversed: 0 })),
  } as unknown as ClubLedgerPort;
  const vouchers = {
    getDailyStats: jest.fn(async () => ({ issued: 4, redeemed: 2, live: 17 })),
  } as unknown as VoucherIssuerPort;
  const parking = {
    getDailyStats: jest.fn(async () => {
      if (options.parkingFails) {
        throw new DomainError('PC_COMMON_NOT_IMPLEMENTED', 'parking is not built yet', {
          status: 501,
        });
      }
      return { opened: 30, closed: 28, paidKopecks: 120_000 };
    }),
  } as unknown as ParkingPort;
  const audits: AuditEntry[] = [];
  const audit: AdminAuditPort = {
    audit: jest.fn(async (entry: AuditEntry) => {
      audits.push(entry);
      return 'audit';
    }),
  };
  const service = new ReportsService(
    prisma as unknown as PrismaService,
    clock,
    receipts,
    ledger,
    vouchers,
    parking,
    audit,
  );
  return { service, prisma, clock, ranges, audits };
}

describe('ReportsService', () => {
  it('computes a complete report for a Kyiv day from the statistics ports', async () => {
    const { service, prisma, ranges } = setup();
    prisma.adjustments = [
      {
        status: 'applied',
        amount: 150,
        createdAt: new Date('2026-01-14T08:00:00.000Z'),
        decidedAt: new Date('2026-01-14T08:00:00.000Z'),
        appliedAt: new Date('2026-01-14T08:00:00.000Z'),
      },
      {
        status: 'pending',
        amount: 900,
        createdAt: new Date('2026-01-14T21:30:00.000Z'),
        decidedAt: null,
        appliedAt: null,
      },
    ];

    const report = await service.compute('2026-01-14', 'manual');

    expect(ranges[0]).toEqual({
      from: new Date('2026-01-13T22:00:00.000Z'),
      to: new Date('2026-01-14T22:00:00.000Z'),
    });
    expect(report).toMatchObject({
      day: '2026-01-14',
      complete: true,
      dayClosed: true,
      source: 'manual',
      errors: {},
      receipts: { submitted: 12 },
      points: { earned: 540, spent: 120 },
      vouchers: { live: 17 },
      parking: { opened: 30 },
      adjustments: { requested: 2, approved: 1, applied: 1, rejected: 0, appliedPoints: 150 },
    });
  });

  it('keeps going when a source fails and reports the failed section', async () => {
    const { service } = setup({ parkingFails: true });
    const report = await service.compute('2026-01-14', 'nightly');
    expect(report.complete).toBe(false);
    expect(report.parking).toBeNull();
    expect(report.errors).toEqual({ parking: 'PC_COMMON_NOT_IMPLEMENTED' });
    expect(report.receipts).not.toBeNull();
  });

  it('marks a report of the current day as not closed', async () => {
    const { service } = setup();
    const report = await service.compute('2026-01-15', 'manual');
    expect(report.dayClosed).toBe(false);
  });

  it('answers PC_REPORT_NOT_READY for yesterday until the report is stored', async () => {
    const { service } = setup();
    await expect(service.getStored()).rejects.toMatchObject({
      code: 'PC_REPORT_NOT_READY',
      status: 404,
      details: { day: '2026-01-14' },
    });
    await service.computeAndStore('2026-01-14', 'nightly');
    await expect(service.getStored()).resolves.toMatchObject({ day: '2026-01-14' });
    await expect(service.hasStored('2026-01-14')).resolves.toBe(true);
    await expect(service.hasStored('2026-01-13')).resolves.toBe(false);
  });

  it('lists stored reports in a range and rejects reversed ranges', async () => {
    const { service } = setup();
    await service.computeAndStore('2026-01-12', 'nightly');
    await service.computeAndStore('2026-01-14', 'nightly');
    const reports = await service.listStored('2026-01-10', '2026-01-14');
    expect(reports.map((report) => report.day)).toEqual(['2026-01-12', '2026-01-14']);
    await expect(service.listStored('2026-01-14', '2026-01-10')).rejects.toMatchObject({
      code: 'PC_REPORT_DAY_INVALID',
    });
  });

  it('rejects impossible days', async () => {
    const { service } = setup();
    await expect(service.getStored('2026-02-30')).rejects.toMatchObject({
      code: 'PC_REPORT_DAY_INVALID',
      status: 400,
    });
  });

  it('recomputes yesterday on demand and audits it', async () => {
    const { service, audits, prisma } = setup();
    const report = await service.recompute(undefined, { id: 'admin-1', ip: '10.0.0.9' });
    expect(report).toMatchObject({ day: '2026-01-14', source: 'manual' });
    expect(prisma.stats.size).toBe(1);
    expect(audits).toEqual([
      expect.objectContaining({
        actor: { type: 'admin', id: 'admin-1' },
        action: 'daily_stat.recompute',
        entityType: 'daily_stat',
        entityId: '2026-01-14',
        ip: '10.0.0.9',
      }),
    ]);
  });
});
