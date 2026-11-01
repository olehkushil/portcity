import { Injectable } from '@nestjs/common';
import {
  RECEIPT_PENDING_STATUSES,
  type ReceiptDailyStats,
  type ReceiptPendingSummary,
  type ReceiptSummary,
  type ReceiptsPort,
} from '../../../common/contracts/receipts';
import type { DateRange } from '../../../common/contracts/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ExpectedPointsService } from './expected-points.service';
import { toReceiptSummary } from './receipt-view';
import { ReceiptsRepository } from './receipts.repository';

/** Unsettled receipts estimated per pending summary; older ones are counted but not estimated. */
export const PENDING_SUMMARY_ESTIMATE_LIMIT = 500;

/** RECEIPTS_PORT implementation (consumers: admin reports, club card). Read-only. */
@Injectable()
export class ReceiptsPortService implements ReceiptsPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ReceiptsRepository,
    private readonly expected: ExpectedPointsService,
  ) {}

  async getReceipt(receiptId: string): Promise<ReceiptSummary | null> {
    const row = await this.repo.findById(this.prisma, receiptId);
    return row ? toReceiptSummary(row) : null;
  }

  countForUser(userId: string, range: DateRange): Promise<number> {
    return this.repo.countForUserBetween(this.prisma, userId, range.from, range.to);
  }

  async getDailyStats(range: DateRange): Promise<ReceiptDailyStats> {
    const [submitted, byStatus, pointsAwarded] = await Promise.all([
      this.repo.countBetween(this.prisma, range),
      this.repo.countByStatusBetween(this.prisma, range),
      this.repo.sumPointsBetween(this.prisma, range),
    ]);
    return { submitted, byStatus, pointsAwarded };
  }

  /**
   * Receipts in moderation (needs_moderation, appealed) or still processing (uploaded, parsed,
   * auto_approved, approved) and the points they would earn by the credit formula.
   */
  async getPendingSummary(userId: string): Promise<ReceiptPendingSummary> {
    const [count, rows] = await Promise.all([
      this.repo.countForUserByStatuses(this.prisma, userId, RECEIPT_PENDING_STATUSES),
      this.repo.listForUserByStatuses(
        this.prisma,
        userId,
        RECEIPT_PENDING_STATUSES,
        PENDING_SUMMARY_ESTIMATE_LIMIT,
      ),
    ]);
    if (count === 0) {
      return { count: 0, expectedPoints: 0 };
    }
    const estimates = await this.expected.estimate(rows);
    let expectedPoints = 0;
    for (const points of estimates.values()) {
      expectedPoints += points;
    }
    return { count, expectedPoints };
  }
}
