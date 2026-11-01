import { expectDomainError } from '../../../../test/receipts/support/assertions';
import {
  HARNESS_NOW,
  INTERTOP_FN,
  INTERTOP_ID,
  MEMBER,
  MODERATOR,
  OTHER_MEMBER,
  type ReceiptsHarness,
  createReceiptsHarness,
  taxQr,
} from '../../../../test/receipts/support/receipts-harness';
import { RECEIPT_EVENTS } from '../../../common/contracts/events';
import { PATTERN_REVIEW_TEXT_UK } from '../domain/submission-view';
import { receiptLedgerKey } from './receipt-pipeline.service';

const NOW = new Date(HARNESS_NOW);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const BASE = 'https://cabinet.tax.gov.ua/cashregs/check';

function qrWith(params: string, issuedAt = ago(HOUR), sm = '500.00'): string {
  const date = '20260115';
  const time = new Date(issuedAt.getTime() + 2 * HOUR)
    .toISOString()
    .slice(11, 19)
    .replace(/:/g, '');
  return `${BASE}?${params}&date=${date}&time=${time}&sm=${sm}`;
}

describe('receipts anti-fraud', () => {
  let h: ReceiptsHarness;

  beforeEach(() => {
    h = createReceiptsHarness();
  });

  describe('canonical fiscal ids (one receipt, one credit)', () => {
    it('refuses every rewritten form of an already credited receipt number', async () => {
      const first = await h.submission.submitQr(MEMBER, qrWith(`fn=${INTERTOP_FN}&id=1180000001`));
      expect(first.outcome).toBe('credited');

      for (const params of [
        `fn=${INTERTOP_FN}&id=01180000001`,
        `fn=${INTERTOP_FN}&id=001180000001`,
        `fn=${INTERTOP_FN}&id=118-000-0001`,
        `fn=${INTERTOP_FN}&id=%20118%20000%200001`,
        `fn=000${INTERTOP_FN}&id=1180000001`,
      ]) {
        await expectDomainError(
          h.submission.submitQr(OTHER_MEMBER, qrWith(params)),
          'PC_RECEIPT_DUPLICATE',
          409,
        );
        await expectDomainError(
          h.submission.submitQr(MEMBER, qrWith(params)),
          'PC_RECEIPT_DUPLICATE',
          409,
        );
      }
      expect(h.repo.receipts).toHaveLength(1);
      expect(h.ledger.countWrites()).toBe(1);
    });

    it('stores canonical values in the key and keeps what was scanned for audit', async () => {
      const raw = qrWith(`fn=0${INTERTOP_FN}&id=ab-12-cd`);
      const result = await h.submission.submitQr(MEMBER, raw);
      expect(result.receipt).toMatchObject({ fn: INTERTOP_FN, fiscalId: 'AB12CD' });
      expect(h.repo.receipts[0]).toMatchObject({
        fn: INTERTOP_FN,
        fiscalId: 'AB12CD',
        fnRaw: `0${INTERTOP_FN}`,
        fiscalIdRaw: 'ab-12-cd',
        rawQr: raw,
      });
      // Letter case is not a new receipt either.
      await expectDomainError(
        h.submission.submitQr(OTHER_MEMBER, qrWith(`fn=${INTERTOP_FN}&id=AB12CD`)),
        'PC_RECEIPT_DUPLICATE',
      );
      const detail = await h.moderation.view(MODERATOR, result.receipt.id);
      expect(detail).toMatchObject({
        fnRaw: `0${INTERTOP_FN}`,
        fiscalIdRaw: 'ab-12-cd',
        rawQr: raw,
      });
    });

    it('catches a manual copy of a QR receipt typed with dashes and zeros', async () => {
      await h.submission.submitQr(MEMBER, qrWith(`fn=${INTERTOP_FN}&id=1180000001`));
      const photoKey = await h.uploadPhoto(OTHER_MEMBER);
      await expectDomainError(
        h.submission.submitManual(OTHER_MEMBER, {
          fn: ` 0${INTERTOP_FN} `,
          fiscalId: '0118-000-0001',
          issuedAt: '2026-01-15T11:00:00',
          totalKopecks: 50_000,
          photoKey,
        }),
        'PC_RECEIPT_DUPLICATE',
        409,
      );
    });
  });

  describe('verification hold (forged QR receipts)', () => {
    it('holds the points of a new account for 24 h and marks the receipt pending verification', async () => {
      h.identity.createdAt.set(MEMBER.userId, ago(5 * DAY));
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 30_050 }),
      );

      expect(result).toMatchObject({
        outcome: 'held',
        screen: 'credited',
        pointsAwarded: 9,
        pointsAvailableAt: '2026-01-16T10:00:00.000Z',
        balance: { available: 0, pending: 9 },
      });
      expect(h.ledger.entries[0]).toMatchObject({
        state: 'pending',
        availableAt: new Date('2026-01-16T10:00:00.000Z'),
      });
      expect(h.repo.receipts[0]).toMatchObject({
        status: 'credited',
        verification: 'pending',
        verifyUntil: new Date('2026-01-16T10:00:00.000Z'),
      });
      expect(h.repo.events.at(-1)?.note).toContain('verification hold');
      expect(h.outbox.ofType(RECEIPT_EVENTS.credited)[0]!.payload).toMatchObject({
        pointsState: 'pending',
        availableAt: '2026-01-16T10:00:00.000Z',
      });
    });

    it('holds a receipt above the fast-track total even on an old account', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_050 }),
      );
      expect(result).toMatchObject({
        outcome: 'held',
        pointsAvailableAt: '2026-01-16T10:00:00.000Z',
      });
    });

    it('credits a small receipt of an old account at once (no verification)', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(result.outcome).toBe('credited');
      expect(h.repo.receipts[0]).toMatchObject({ verification: 'not_required', verifyUntil: null });
    });

    it('treats an unknown or unreachable account as new', async () => {
      h.identity.createdAt.delete(MEMBER.userId);
      const unknown = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 30_050 }),
      );
      expect(unknown.outcome).toBe('held');

      h.identity.failGetUser = true;
      const unreachable = await h.submission.submitQr(
        OTHER_MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 30_150 }),
      );
      expect(unreachable.outcome).toBe('held');
    });

    it('keeps the 7-day hold of a high total and verifies until its end', async () => {
      h.ledger.rules = { ...h.ledger.rules, autoApproveThresholdKopecks: 1_000_000 };
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 350_050 }),
      );
      expect(result.pointsAvailableAt).toBe('2026-01-22T10:00:00.000Z');
      expect(h.repo.receipts[0]).toMatchObject({
        verification: 'pending',
        verifyUntil: new Date('2026-01-22T10:00:00.000Z'),
      });
    });

    it('skips the hold when the tax checker confirms the receipt during the decision', async () => {
      h.identity.createdAt.set(MEMBER.userId, ago(DAY));
      h.verifier.fallback = { status: 'confirmed' };
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 30_050 }),
      );
      expect(result.outcome).toBe('credited');
      expect(h.repo.receipts[0]).toMatchObject({ verification: 'confirmed' });
      expect(h.verifier.calls[0]).toMatchObject({
        fn: INTERTOP_FN,
        totalKopecks: 30_050,
        mac: null,
      });
    });

    it('sends a receipt the tax checker rejects to moderation with a neutral member text', async () => {
      h.verifier.fallback = { status: 'rejected', detail: 'not found at the tax service' };
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 30_050 }),
      );
      expect(result).toMatchObject({
        outcome: 'needs_moderation',
        moderationReasons: [PATTERN_REVIEW_TEXT_UK],
      });
      expect(h.repo.receipts[0]).toMatchObject({
        moderationReasons: ['tax_check_failed'],
        verification: 'rejected',
      });
      expect(h.repo.events.at(-1)?.note).toContain('tax check: rejected');
    });

    it('treats a failing checker as unknown', async () => {
      h.verifier.failNext = true;
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 30_050 }),
      );
      expect(result.outcome).toBe('credited');
    });

    it('can be switched off with RECEIPTS_VERIFY_HOLD_HOURS=0', async () => {
      const off = createReceiptsHarness({ RECEIPTS_VERIFY_HOLD_HOURS: 0 });
      off.identity.createdAt.set(MEMBER.userId, ago(DAY));
      const result = await off.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 30_050 }),
      );
      expect(result.outcome).toBe('credited');
    });

    it('never holds a receipt a moderator approved', async () => {
      h.identity.createdAt.set(MEMBER.userId, ago(DAY));
      const photoKey = await h.uploadPhoto();
      const moderated = await h.submission.submitManual(MEMBER, {
        fn: INTERTOP_FN,
        fiscalId: 'NEWACC-1',
        issuedAt: '2026-01-15T11:00:00',
        totalKopecks: 42_050,
        photoKey,
      });
      const detail = await h.moderation.approve(MODERATOR, moderated.receipt.id, {});
      expect(detail.status).toBe('credited');
      expect(h.ledger.entries[0]).toMatchObject({ state: 'available', amount: 12 });
      expect(detail.verification).toBe('not_required');
    });
  });

  describe('daily QR points cap', () => {
    function creditedToday(points: number, index = 0, source: 'qr' | 'manual' = 'qr'): void {
      h.repo.insert({
        id: `00000000-0000-7000-8000-0000000005${String(index).padStart(2, '0')}`,
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: `CAPDAY${index}`,
        source,
        status: 'credited',
        pointsAwarded: points,
        submittedAt: ago(2 * HOUR),
      });
    }

    it('moderates a QR receipt that would take the member above 150 points today', async () => {
      creditedToday(140);
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(result).toMatchObject({
        outcome: 'needs_moderation',
        moderationReasons: ['Досягнуто денного ліміту балів за QR-чеки'],
      });
      expect(h.ledger.countWrites()).toBe(0);
    });

    it('lets a receipt that lands exactly on the cap through', async () => {
      creditedToday(135);
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(result).toMatchObject({ outcome: 'credited', pointsAwarded: 15 });
    });

    it('ignores manual receipts and yesterday when summing the day', async () => {
      creditedToday(140, 1, 'manual');
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000599',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'CAPYESTERDAY',
        status: 'credited',
        pointsAwarded: 140,
        submittedAt: new Date('2026-01-14T21:00:00.000Z'),
      });
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(result.outcome).toBe('credited');
    });

    it('re-checks the cap under the member lock and moderates a receipt overtaken by a concurrent one', async () => {
      h.ledger.failNext('credit');
      const pending = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(pending.receipt.status).toBe('auto_approved');
      // A concurrent receipt of the same member was credited between the decision and the credit.
      creditedToday(140, 2);

      const retried = await h.pipeline.process(pending.receipt.id);
      expect(retried.receipt).toMatchObject({ status: 'needs_moderation' });
      expect(retried.receipt.moderationReasons).toEqual(['daily_points_cap']);
      expect(h.ledger.entries).toHaveLength(0);
      expect(h.repo.lockedMembers).toContain(MEMBER.userId);
      expect(h.repo.events.at(-1)).toMatchObject({
        fromStatus: 'auto_approved',
        toStatus: 'needs_moderation',
      });
      expect(h.outbox.types().at(-1)).toBe(RECEIPT_EVENTS.needsModeration);

      // The moderator may still approve it: an approval is never capped.
      const approved = await h.moderation.approve(MODERATOR, pending.receipt.id, {});
      expect(approved).toMatchObject({ status: 'credited', pointsAwarded: 15 });
    });
  });

  describe('tenant daily cap under the member lock', () => {
    it('reads the tenant points of the day after taking the lock, inside the credit transaction', async () => {
      h.content.rules.set(INTERTOP_ID, {
        tenantId: INTERTOP_ID,
        ratePercent: null,
        minTotalKopecks: 0,
        dailyCapPoints: 20,
        source: 'rule',
      });
      const order: string[] = [];
      const lock = h.repo.lockMember.bind(h.repo);
      const sum = h.repo.sumPointsForTenantBetween.bind(h.repo);
      jest.spyOn(h.repo, 'lockMember').mockImplementation(async (tx, userId) => {
        order.push(`lock:${String(tx !== null)}`);
        return lock(tx, userId);
      });
      jest.spyOn(h.repo, 'sumPointsForTenantBetween').mockImplementation(async (db, ...rest) => {
        order.push('tenant-sum');
        return sum(db, ...rest);
      });

      h.ledger.failNext('credit');
      const pending = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      // Another receipt of the same tenant was credited meanwhile (15 of the 20 points).
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000610',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'TENANTRACE',
        tenantId: INTERTOP_ID,
        status: 'credited',
        pointsAwarded: 15,
        submittedAt: ago(30 * MINUTE),
      });
      order.length = 0;
      const retried = await h.pipeline.process(pending.receipt.id);

      expect(retried.receipt).toMatchObject({ status: 'credited', pointsAwarded: 5 });
      expect(order.slice(0, 2)).toEqual(['lock:true', 'tenant-sum']);
      expect(h.ledger.entries[0]).toMatchObject({
        amount: 5,
        idempotencyKey: receiptLedgerKey(pending.receipt.id),
      });
    });
  });

  describe('fraud patterns', () => {
    it('moderates the same total from the same cash register sent by another member within 24 h', async () => {
      await h.submission.submitQr(
        OTHER_MEMBER,
        taxQr({ issuedAt: ago(3 * HOUR), totalKopecks: 43_210 }),
      );
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 43_210 }),
      );
      expect(result).toMatchObject({
        outcome: 'needs_moderation',
        moderationReasons: [PATTERN_REVIEW_TEXT_UK],
      });
      expect(h.repo.receipts.at(-1)?.moderationReasons).toEqual(['same_total_other_user']);
    });

    it('does not compare with receipts older than 24 h or rejected ones', async () => {
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000700',
        userId: OTHER_MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'OLDTOTAL',
        totalKopecks: 43_210,
        submittedAt: ago(25 * HOUR),
      });
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000701',
        userId: OTHER_MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'REJTOTAL',
        totalKopecks: 43_210,
        status: 'rejected',
        submittedAt: ago(2 * HOUR),
      });
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 43_210 }),
      );
      expect(result.outcome).toBe('credited');
    });

    it('moderates a round total when the member sent another round total within 30 days', async () => {
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000710',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'ROUND1',
        totalKopecks: 30_000,
        submittedAt: ago(10 * DAY),
      });
      const round = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 20_000 }),
      );
      expect(h.repo.receipts.at(-1)?.moderationReasons).toEqual(['round_total_repeat']);
      expect(round.moderationReasons).toEqual([PATTERN_REVIEW_TEXT_UK]);

      const notRound = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 20_050 }),
      );
      expect(notRound.outcome).toBe('credited');
    });

    it('forgets round totals older than 30 days', async () => {
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000720',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'ROUNDOLD',
        totalKopecks: 30_000,
        submittedAt: ago(31 * DAY),
      });
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 20_000 }),
      );
      expect(result.outcome).toBe('credited');
    });

    it('moderates a receipt number of the same register that goes against time', async () => {
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000730',
        userId: OTHER_MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: '1180000100',
        issuedAt: ago(3 * HOUR),
        totalKopecks: 12_345,
        submittedAt: ago(3 * HOUR),
      });
      const forged = await h.submission.submitQr(
        MEMBER,
        taxQr({ fiscalId: '1180000050', issuedAt: ago(HOUR), totalKopecks: 23_456 }),
      );
      expect(h.repo.receipts.at(-1)?.moderationReasons).toEqual(['fiscal_id_out_of_order']);
      expect(forged.outcome).toBe('needs_moderation');

      const inOrder = await h.submission.submitQr(
        MEMBER,
        taxQr({ fiscalId: '1180000200', issuedAt: ago(HOUR), totalKopecks: 23_457 }),
      );
      expect(inOrder.outcome).toBe('credited');
    });
  });
});
