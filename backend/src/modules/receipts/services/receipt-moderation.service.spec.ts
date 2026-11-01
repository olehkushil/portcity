import { expectDomainError } from '../../../../test/receipts/support/assertions';
import {
  HARNESS_NOW,
  INTERTOP_FN,
  MEMBER,
  MODERATOR,
  type ReceiptsHarness,
  TAMTAM_FN,
  createReceiptsHarness,
  taxQr,
} from '../../../../test/receipts/support/receipts-harness';
import { RECEIPT_EVENTS } from '../../../common/contracts/events';
import { receiptLedgerKey } from './receipt-pipeline.service';

const NOW = new Date(HARNESS_NOW);
const HOUR = 3_600_000;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('ReceiptModerationService', () => {
  let h: ReceiptsHarness;

  beforeEach(() => {
    h = createReceiptsHarness();
  });

  async function moderated(totalKopecks = 1_250_000, fiscalId?: string): Promise<string> {
    const result = await h.submission.submitQr(
      MEMBER,
      taxQr({ issuedAt: ago(HOUR), totalKopecks, ...(fiscalId ? { fiscalId } : {}) }),
    );
    expect(result.receipt.status).toBe('needs_moderation');
    return result.receipt.id;
  }

  async function manual(): Promise<string> {
    const photoKey = await h.uploadPhoto();
    const result = await h.submission.submitManual(MEMBER, {
      fn: INTERTOP_FN,
      fiscalId: 'MANUAL-1',
      issuedAt: '2026-01-15T11:00:00',
      totalKopecks: 42_000,
      photoKey,
    });
    return result.receipt.id;
  }

  describe('GET /admin/receipts', () => {
    it('serves the moderation queue oldest first and filters by status', async () => {
      const first = await moderated(1_250_000, 'Q-1');
      h.clock.advanceMinutes(5);
      const second = await moderated(1_300_000, 'Q-2');
      // Not a round total: round totals repeated by one member go to moderation.
      await h.submission.submitQr(MEMBER, taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_050 }));

      const queue = await h.moderation.list({ status: 'needs_moderation', limit: 20 });
      expect(queue.items.map((item) => item.id)).toEqual([first, second]);
      expect(queue.items[0]).toMatchObject({
        userId: MEMBER.userId,
        riskFlags: ['high_total'],
        riskScore: 40,
        tenant: { name: 'INTERTOP' },
      });

      const all = await h.moderation.list({ limit: 20 });
      expect(all.items).toHaveLength(3);
      expect(all.items[0]!.status).toBe('credited');
    });
  });

  describe('GET /admin/receipts/:id', () => {
    it('returns the signed photo URL and audits the view', async () => {
      const receiptId = await manual();
      const detail = await h.moderation.view(MODERATOR, receiptId);

      expect(detail.photoUrl).toMatch(/^memory:\/\/memory\/receipts\//);
      expect(detail.photoKey).toMatch(new RegExp(`^receipts/${MEMBER.userId}/`));
      expect(detail.events.at(-1)).toMatchObject({
        toStatus: 'needs_moderation',
        note: 'moderation: manual_submission',
      });
      expect(h.audit.entries).toEqual([
        expect.objectContaining({
          actor: { type: 'admin', id: MODERATOR.adminId },
          action: 'receipt.view',
          entityType: 'receipt',
          entityId: receiptId,
          ip: MODERATOR.ip,
        }),
      ]);
    });

    it('answers 404 for an unknown receipt', async () => {
      await expectDomainError(
        h.moderation.view(MODERATOR, '0192f3a0-9999-7000-8000-000000000000'),
        'PC_RECEIPT_NOT_FOUND',
        404,
      );
      expect(h.audit.entries).toHaveLength(0);
    });
  });

  describe('POST /admin/receipts/:id/approve', () => {
    it('approves, credits through the ledger, publishes events and audits in the transaction', async () => {
      const manualId = await manual();
      h.outbox.events = [];

      const detail = await h.moderation.approve(MODERATOR, manualId, { reason: 'Фото чітке' });

      expect(detail).toMatchObject({
        status: 'credited',
        moderatorId: MODERATOR.adminId,
        pointsAwarded: 12,
        decisionReason: null,
      });
      expect(h.ledger.entries.at(-1)).toMatchObject({
        amount: 12,
        state: 'available',
        idempotencyKey: receiptLedgerKey(manualId),
      });
      expect(h.outbox.types()).toEqual([RECEIPT_EVENTS.approved, RECEIPT_EVENTS.credited]);
      expect(h.outbox.ofType(RECEIPT_EVENTS.approved)[0]!.payload).toEqual({
        receiptId: manualId,
        userId: MEMBER.userId,
        moderatorId: MODERATOR.adminId,
      });
      expect(
        detail.events.slice(-2).map((event) => [event.toStatus, event.actorType, event.actorId]),
      ).toEqual([
        ['approved', 'admin', MODERATOR.adminId],
        ['credited', 'system', null],
      ]);
      const approval = h.audit.entries.find((entry) => entry.action === 'receipt.approve');
      expect(approval).toMatchObject({
        inTx: true,
        entityId: manualId,
        reason: 'Фото чітке',
        ip: MODERATOR.ip,
        before: expect.objectContaining({ status: 'needs_moderation', moderatorId: null }),
        after: expect.objectContaining({ status: 'approved', moderatorId: MODERATOR.adminId }),
      });
    });

    it('holds the points of an approved receipt above the hold threshold', async () => {
      const receiptId = await moderated(350_000);
      const detail = await h.moderation.approve(MODERATOR, receiptId, {});

      expect(detail.status).toBe('credited');
      expect(h.ledger.entries[0]).toMatchObject({
        state: 'pending',
        amount: 105,
        availableAt: new Date('2026-01-22T10:00:00.000Z'),
      });
      expect(h.outbox.ofType(RECEIPT_EVENTS.credited)[0]!.payload).toMatchObject({
        pointsState: 'pending',
        availableAt: '2026-01-22T10:00:00.000Z',
        firstReceipt: true,
      });
    });

    it('leaves the receipt approved and queues receipts-process when the ledger is down', async () => {
      // 1 500 UAH: moderated (above 1 000 UAH) and credited immediately (below 3 000 UAH).
      const receiptId = await moderated(150_000);
      h.ledger.failNext('credit');

      const detail = await h.moderation.approve(MODERATOR, receiptId, {});

      expect(detail.status).toBe('approved');
      expect(h.ledger.entries).toHaveLength(0);
      expect(h.audit.actions()).toEqual(['receipt.approve']);
      expect(h.queueBackend.jobs).toEqual([
        expect.objectContaining({
          name: 'process',
          id: `receipt-${receiptId}-approve-${NOW.getTime()}`,
          data: { receiptId },
        }),
      ]);

      const retried = await h.pipeline.process(receiptId);
      expect(retried.receipt.status).toBe('credited');
      expect(h.ledger.countWrites()).toBe(2);
      expect(h.ledger.entries).toHaveLength(1);
    });

    it('rolls the approval back when the audit write fails', async () => {
      const receiptId = await moderated();
      jest.spyOn(h.audit, 'audit').mockRejectedValueOnce(new Error('audit down'));

      await expect(h.moderation.approve(MODERATOR, receiptId, {})).rejects.toThrow('audit down');

      expect(h.repo.receipts.find((row) => row.id === receiptId)?.status).toBe('needs_moderation');
      expect(h.outbox.ofType(RECEIPT_EVENTS.approved)).toHaveLength(0);
      expect(h.ledger.countWrites()).toBe(0);
    });

    it('refuses receipts outside the moderation queue', async () => {
      const credited = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      const error = await expectDomainError(
        h.moderation.approve(MODERATOR, credited.receipt.id, {}),
        'PC_RECEIPT_INVALID_TRANSITION',
        409,
      );
      expect(error.details).toMatchObject({ status: 'credited' });
      await expectDomainError(
        h.moderation.approve(MODERATOR, '0192f3a0-9999-7000-8000-000000000000', {}),
        'PC_RECEIPT_NOT_FOUND',
      );
    });

    it('reviews an appealed receipt: appealed -> needs_moderation -> approved -> credited', async () => {
      const rejected = await h.submission.submitQr(
        MEMBER,
        taxQr({ fn: TAMTAM_FN, issuedAt: ago(HOUR), totalKopecks: 42_000 }),
      );
      await h.submission.appeal(MEMBER, rejected.receipt.id, { message: 'Це кафе, не ТамТам' });

      const queue = await h.moderation.list({ status: 'appealed', limit: 20 });
      expect(queue.items.map((item) => item.id)).toEqual([rejected.receipt.id]);

      const detail = await h.moderation.approve(MODERATOR, rejected.receipt.id, {
        reason: 'Помилкова каса',
      });

      expect(detail.status).toBe('credited');
      expect(detail.pointsAwarded).toBe(12);
      expect(detail.events.slice(-3).map((event) => [event.fromStatus, event.toStatus])).toEqual([
        ['appealed', 'needs_moderation'],
        ['needs_moderation', 'approved'],
        ['approved', 'credited'],
      ]);
      expect(detail.appeals[0]).toMatchObject({
        resolvedById: MODERATOR.adminId,
        resolution: 'approved: Помилкова каса',
      });
      expect(detail.appeals[0]!.resolvedAt).not.toBeNull();
    });
  });

  describe('POST /admin/receipts/:id/reject', () => {
    it('rejects with a reason shown to the member, publishes and audits', async () => {
      const receiptId = await moderated();
      const detail = await h.moderation.reject(MODERATOR, receiptId, {
        reason: '  Сума на фото не збігається  ',
      });

      expect(detail).toMatchObject({
        status: 'rejected',
        decisionReason: 'Сума на фото не збігається',
        moderatorId: MODERATOR.adminId,
        canAppeal: true,
      });
      expect(h.outbox.ofType(RECEIPT_EVENTS.rejected)[0]!.payload).toEqual({
        receiptId,
        userId: MEMBER.userId,
        moderatorId: MODERATOR.adminId,
        reason: 'Сума на фото не збігається',
        code: null,
      });
      expect(h.audit.entries.at(-1)).toMatchObject({
        action: 'receipt.reject',
        reason: 'Сума на фото не збігається',
        inTx: true,
      });
      expect(h.ledger.countWrites()).toBe(0);

      const member = await h.submission.get(MEMBER.userId, receiptId);
      expect(member).toMatchObject({ status: 'rejected', rejectionCode: null, canAppeal: true });
    });

    it('resolves the open appeal when an appealed receipt is rejected again', async () => {
      const rejected = await h.submission.submitQr(
        MEMBER,
        taxQr({ fn: TAMTAM_FN, issuedAt: ago(HOUR), totalKopecks: 42_000 }),
      );
      expect(h.repo.receipts.at(-1)?.rejectionCode).toBe('PC_RECEIPT_EXCLUDED_TENANT');
      await h.submission.appeal(MEMBER, rejected.receipt.id, { message: 'Перевірте' });
      const detail = await h.moderation.reject(MODERATOR, rejected.receipt.id, {
        reason: 'Каса ТамТам',
      });
      expect(detail.status).toBe('rejected');
      expect(detail.appeals[0]).toMatchObject({ resolution: 'rejected: Каса ТамТам' });
      expect(detail.canAppeal).toBe(false);
      // The moderator's decision replaces the rule rejection: a reason, no rule code.
      expect(detail.rejectionCode).toBeNull();
    });

    it('lists the queue by moderation reason and shows the stored reasons', async () => {
      const receiptId = await moderated();
      await h.submission.submitQr(MEMBER, taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_050 }));
      const byReason = await h.moderation.list({ reason: 'total_above_threshold', limit: 20 });
      expect(byReason.items.map((item) => item.id)).toEqual([receiptId]);
      expect(byReason.items[0]).toMatchObject({
        moderationReasons: ['total_above_threshold'],
        rejectionCode: null,
      });
      expect((await h.moderation.list({ reason: 'same_fn_burst', limit: 20 })).items).toEqual([]);
    });

    it('cannot reject a receipt that was already decided', async () => {
      const receiptId = await moderated();
      await h.moderation.reject(MODERATOR, receiptId, { reason: 'Дублікат' });
      await expectDomainError(
        h.moderation.reject(MODERATOR, receiptId, { reason: 'Ще раз' }),
        'PC_RECEIPT_INVALID_TRANSITION',
      );
    });
  });
});
