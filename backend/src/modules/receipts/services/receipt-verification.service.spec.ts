import {
  HARNESS_NOW,
  MEMBER,
  MODERATOR,
  type ReceiptsHarness,
  createReceiptsHarness,
  taxQr,
} from '../../../../test/receipts/support/receipts-harness';
import { RECEIPT_EVENTS } from '../../../common/contracts/events';
import { receiptLedgerKey } from './receipt-pipeline.service';
import { receiptUnverifiedLedgerKey } from './receipt-verification.service';

const NOW = new Date(HARNESS_NOW);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('ReceiptVerificationService (verify-held job)', () => {
  let h: ReceiptsHarness;

  beforeEach(() => {
    h = createReceiptsHarness();
    // A new account: every QR receipt is credited as pending for 24 h.
    h.identity.createdAt.set(MEMBER.userId, new Date(NOW.getTime() - 2 * DAY));
  });

  async function heldReceipt(totalKopecks = 30_050): Promise<string> {
    const result = await h.submission.submitQr(
      MEMBER,
      taxQr({ issuedAt: new Date(NOW.getTime() - HOUR), totalKopecks }),
    );
    expect(result.outcome).toBe('held');
    return result.receipt.id;
  }

  it('reverses the pending points and rejects the receipt when the checker rejects it', async () => {
    const receiptId = await heldReceipt();
    h.clock.advanceMinutes(30);
    h.verifier.answers.set(receiptId, { status: 'rejected', detail: 'unknown receipt' });

    await expect(h.verification.verifyHeld()).resolves.toEqual({
      checked: 1,
      confirmed: 0,
      rejected: 1,
      unconfirmed: 0,
    });

    expect(h.ledger.entries[0]).toMatchObject({ state: 'cancelled' });
    expect(h.ledger.calls.at(-1)).toEqual({
      method: 'reverse',
      key: receiptUnverifiedLedgerKey(receiptId),
    });
    const stored = h.repo.receipts.find((row) => row.id === receiptId)!;
    expect(stored).toMatchObject({
      status: 'rejected',
      verification: 'rejected',
      rejectionCode: 'PC_RECEIPT_NOT_VERIFIED',
      decisionReason: 'Податкова служба не підтвердила цей чек',
      pointsAwarded: 0,
    });
    expect(h.repo.events.at(-1)).toMatchObject({
      fromStatus: 'credited',
      toStatus: 'rejected',
      actorType: 'system',
    });
    expect(h.outbox.ofType(RECEIPT_EVENTS.rejected).at(-1)!.payload).toMatchObject({
      receiptId,
      code: 'PC_RECEIPT_NOT_VERIFIED',
      moderatorId: null,
    });

    const detail = await h.submission.get(MEMBER.userId, receiptId);
    expect(detail).toMatchObject({
      status: 'rejected',
      rejectionCode: 'PC_RECEIPT_NOT_VERIFIED',
      canAppeal: true,
    });
  });

  it('re-credits under a new ledger key when a moderator approves the appeal', async () => {
    const receiptId = await heldReceipt();
    h.verifier.answers.set(receiptId, { status: 'rejected' });
    await h.verification.verifyHeld();
    await h.submission.appeal(MEMBER, receiptId, { message: 'Чек справжній, ось фото' });

    const approved = await h.moderation.approve(MODERATOR, receiptId, {});
    expect(approved).toMatchObject({ status: 'credited', pointsAwarded: 9 });
    expect(h.ledger.entries.map((entry) => [entry.idempotencyKey, entry.state])).toEqual([
      [receiptLedgerKey(receiptId), 'cancelled'],
      [receiptLedgerKey(receiptId, 'reinstated'), 'available'],
    ]);
    expect(approved.pointsTxId).toBe(h.ledger.entries[1]!.id);
  });

  it('marks a confirmed receipt and leaves the points to the release job', async () => {
    const receiptId = await heldReceipt();
    h.verifier.answers.set(receiptId, { status: 'confirmed' });
    await expect(h.verification.verifyHeld()).resolves.toMatchObject({ confirmed: 1 });
    expect(h.repo.receipts[0]).toMatchObject({ status: 'credited', verification: 'confirmed' });
    expect(h.ledger.entries[0]).toMatchObject({ state: 'pending' });
    // Nothing left to verify.
    await expect(h.verification.verifyHeld()).resolves.toMatchObject({ checked: 0 });
  });

  it('keeps asking during the hold and gives up when it ends', async () => {
    await heldReceipt();
    h.clock.advanceMinutes(60);
    await expect(h.verification.verifyHeld()).resolves.toMatchObject({
      checked: 1,
      unconfirmed: 0,
    });
    expect(h.repo.receipts[0]).toMatchObject({
      verification: 'pending',
      verificationCheckedAt: new Date(NOW.getTime() + HOUR),
    });

    h.clock.advanceMinutes(24 * 60);
    await expect(h.verification.verifyHeld()).resolves.toMatchObject({ unconfirmed: 1 });
    expect(h.repo.receipts[0]).toMatchObject({ status: 'credited', verification: 'unconfirmed' });
    expect(h.ledger.entries[0]).toMatchObject({ state: 'pending' });
  });

  it('skips receipts that are not in a verification hold', async () => {
    h.identity.createdAt.set(MEMBER.userId, new Date(NOW.getTime() - 365 * DAY));
    await h.submission.submitQr(
      MEMBER,
      taxQr({ issuedAt: new Date(NOW.getTime() - HOUR), totalKopecks: 30_050 }),
    );
    h.verifier.fallback = { status: 'rejected' };
    await expect(h.verification.verifyHeld()).resolves.toEqual({
      checked: 0,
      confirmed: 0,
      rejected: 0,
      unconfirmed: 0,
    });
    expect(h.repo.receipts[0]).toMatchObject({ status: 'credited' });
  });
});
