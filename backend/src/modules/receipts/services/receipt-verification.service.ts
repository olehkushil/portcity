import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Receipt } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../../common/contracts/club';
import {
  OUTBOX_AGGREGATES,
  RECEIPT_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { REJECTION_REASONS_UK } from '../domain/rules';
import { assertTransition } from '../domain/state-machine';
import { ReceiptPipelineService, receiptLedgerDisplay } from './receipt-pipeline.service';
import { ReceiptsRepository } from './receipts.repository';

/** Receipts checked per run of the `verify-held` job. */
export const VERIFY_HELD_BATCH = 100;

export interface VerifyHeldSummary {
  checked: number;
  confirmed: number;
  rejected: number;
  /** The hold ended without a definitive answer. */
  unconfirmed: number;
}

/** Ledger idempotency key of the reversal of an unverified receipt's points. */
export function receiptUnverifiedLedgerKey(receiptId: string): string {
  return `receipt-unverified:${receiptId}`;
}

class ReceiptChangedConcurrently extends Error {
  constructor(readonly receiptId: string) {
    super(`Receipt ${receiptId} changed while it was being verified`);
    this.name = 'ReceiptChangedConcurrently';
  }
}

/**
 * The `verify-held` job of the `receipts-process` queue: asks TaxReceiptVerifierPort again about
 * credited QR receipts in their verification hold (Receipt.verification = pending).
 * - `confirmed` -> verification confirmed (the points are released by club at availableAt);
 * - `rejected`  -> the pending points are reversed through CLUB_LEDGER_PORT and the receipt
 *   becomes `rejected` (PC_RECEIPT_NOT_VERIFIED, appealable) with receipt.rejected;
 * - `unknown`   -> asked again next run until verify_until, then `unconfirmed`.
 */
@Injectable()
export class ReceiptVerificationService {
  private readonly logger = new Logger(ReceiptVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: ReceiptsRepository,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly pipeline: ReceiptPipelineService,
    @Inject(CLUB_LEDGER_PORT) private readonly ledger: ClubLedgerPort,
  ) {}

  async verifyHeld(limit: number = VERIFY_HELD_BATCH): Promise<VerifyHeldSummary> {
    const rows = await this.repo.listPendingVerification(this.prisma, limit);
    const summary: VerifyHeldSummary = { checked: 0, confirmed: 0, rejected: 0, unconfirmed: 0 };
    for (const row of rows) {
      summary.checked += 1;
      const result = await this.pipeline.checkTax(row);
      const now = this.clock.now();
      try {
        if (result.status === 'rejected') {
          await this.rejectUnverified(row, result.detail ?? null, now);
          summary.rejected += 1;
        } else if (result.status === 'confirmed') {
          await this.repo.updateVerification(this.prisma, row.id, 'pending', {
            verification: 'confirmed',
            verificationCheckedAt: now,
          });
          summary.confirmed += 1;
        } else if (row.verifyUntil === null || row.verifyUntil.getTime() <= now.getTime()) {
          await this.repo.updateVerification(this.prisma, row.id, 'pending', {
            verification: 'unconfirmed',
            verificationCheckedAt: now,
          });
          summary.unconfirmed += 1;
        } else {
          await this.repo.updateVerification(this.prisma, row.id, 'pending', {
            verification: 'pending',
            verificationCheckedAt: now,
          });
        }
      } catch (error) {
        if (error instanceof ReceiptChangedConcurrently) {
          continue;
        }
        throw error;
      }
    }
    if (summary.checked > 0) {
      this.logger.log(
        `verify-held: checked ${summary.checked}, confirmed ${summary.confirmed}, rejected ${summary.rejected}, unconfirmed ${summary.unconfirmed}`,
      );
    }
    return summary;
  }

  /** credited -> rejected with the pending points reversed, in one transaction. */
  private async rejectUnverified(row: Receipt, detail: string | null, now: Date): Promise<void> {
    assertTransition('credited', 'rejected', 'system');
    const reason = REJECTION_REASONS_UK.PC_RECEIPT_NOT_VERIFIED;
    await this.prisma.withTx(async (tx) => {
      if (row.pointsTxId !== null) {
        const display = receiptLedgerDisplay(row, null);
        await this.ledger.reverse(
          {
            txId: row.pointsTxId,
            idempotencyKey: receiptUnverifiedLedgerKey(row.id),
            reason: `Чек не підтверджено податковою службою (${row.id})`,
            title: 'Чек не підтверджено',
            ...(display.counterparty ? { counterparty: display.counterparty } : {}),
          },
          tx,
        );
      }
      const moved = await this.repo.transitionStatus(tx, row.id, 'credited', {
        status: 'rejected',
        verification: 'rejected',
        verificationCheckedAt: now,
        rejectionCode: 'PC_RECEIPT_NOT_VERIFIED',
        decisionReason: reason,
        decidedAt: now,
        moderatorId: null,
        pointsAwarded: 0,
      });
      if (!moved) {
        throw new ReceiptChangedConcurrently(row.id);
      }
      await this.repo.addEvent(tx, {
        id: uuidv7(),
        receiptId: row.id,
        fromStatus: 'credited',
        toStatus: 'rejected',
        actorType: 'system',
        actorId: null,
        note: `PC_RECEIPT_NOT_VERIFIED: tax check rejected${detail ? ` (${detail})` : ''}; points reversed`,
        createdAt: now,
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(RECEIPT_EVENTS.rejected, OUTBOX_AGGREGATES.receipt, row.id, {
          receiptId: row.id,
          userId: row.userId,
          moderatorId: null,
          reason,
          code: 'PC_RECEIPT_NOT_VERIFIED',
        }),
      );
    });
  }
}
