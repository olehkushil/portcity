import { Prisma } from '@prisma/client';
import { expectDomainError } from '../../../../test/receipts/support/assertions';
import {
  HARNESS_NOW,
  INTERTOP_FN,
  INTERTOP_ID,
  MEMBER,
  MODERATOR,
  OTHER_MEMBER,
  type ReceiptsHarness,
  TAMTAM_FN,
  UNKNOWN_FN,
  createReceiptsHarness,
  taxQr,
} from '../../../../test/receipts/support/receipts-harness';
import { RECEIPT_EVENTS } from '../../../common/contracts/events';
import { receiptLedgerKey } from './receipt-pipeline.service';

const NOW = new Date(HARNESS_NOW);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('ReceiptSubmissionService', () => {
  let h: ReceiptsHarness;

  beforeEach(() => {
    h = createReceiptsHarness();
  });

  describe('POST /receipts/qr', () => {
    it('auto-approves a clean receipt and credits points through the ledger', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000, fiscalId: '1180000001' }),
      );

      expect(result).toMatchObject({
        outcome: 'credited',
        screen: 'credited',
        title: 'Чек зараховано',
        pointsAwarded: 15,
        pointsAvailableAt: null,
        rejectionCode: null,
        moderationReasons: [],
        balance: { available: 15, pending: 0 },
      });
      expect(result.message).toContain('+15 балів');
      expect(result.receipt).toMatchObject({
        status: 'credited',
        source: 'qr',
        fn: INTERTOP_FN,
        fiscalId: '1180000001',
        totalKopecks: 50_000,
        pointsAwarded: 15,
        tenant: { id: INTERTOP_ID, name: 'INTERTOP' },
        canAppeal: false,
      });

      const receiptId = result.receipt.id;
      expect(h.ledger.entries).toHaveLength(1);
      expect(h.ledger.entries[0]).toMatchObject({
        userId: MEMBER.userId,
        amount: 15,
        state: 'available',
        sourceType: 'receipt',
        sourceId: receiptId,
        idempotencyKey: receiptLedgerKey(receiptId),
        expiresAt: new Date('2027-01-15T10:00:00.000Z'),
      });

      const stored = h.repo.receipts[0]!;
      expect(stored).toMatchObject({
        status: 'credited',
        tenantId: INTERTOP_ID,
        deviceId: MEMBER.deviceId,
        pointsTxId: h.ledger.entries[0]!.id,
        riskFlags: [],
        riskScore: 0,
      });
      expect(
        h.repo.events.map((event) => [event.fromStatus, event.toStatus, event.actorType]),
      ).toEqual([
        [null, 'uploaded', 'user'],
        ['uploaded', 'parsed', 'system'],
        ['parsed', 'auto_approved', 'system'],
        ['auto_approved', 'credited', 'system'],
      ]);
      expect(h.outbox.types()).toEqual([RECEIPT_EVENTS.submitted, RECEIPT_EVENTS.credited]);
      expect(h.outbox.ofType(RECEIPT_EVENTS.credited)[0]!.payload).toEqual({
        receiptId,
        userId: MEMBER.userId,
        tenantId: INTERTOP_ID,
        totalKopecks: 50_000,
        pointsAwarded: 15,
        pointsTxId: h.ledger.entries[0]!.id,
        pointsState: 'available',
        availableAt: null,
        firstReceipt: true,
      });
      expect(h.queueBackend.jobs).toHaveLength(0);
    });

    it('passes display data to the club ledger (title, subtitle, counterparty)', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 45_050 }),
      );
      expect(h.ledger.inputs[0]).toMatchObject({
        title: 'Нарахування за чек',
        subtitle: 'INTERTOP · 450,50 ₴',
        counterparty: {
          tenantId: INTERTOP_ID,
          tenantName: 'INTERTOP',
          receiptId: result.receipt.id,
          receiptTotalKopecks: 45_050,
        },
      });
    });

    it('marks only the first credited receipt as firstReceipt', async () => {
      await h.submission.submitQr(MEMBER, taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }));
      await h.submission.submitQr(MEMBER, taxQr({ issuedAt: ago(HOUR), totalKopecks: 41_230 }));
      const credited = h.outbox.ofType(RECEIPT_EVENTS.credited).map((event) => event.payload);
      expect(credited.map((payload) => payload.firstReceipt)).toEqual([true, false]);
    });

    it('holds the points for 7 days when the total is above the hold threshold', async () => {
      h.ledger.rules = { ...h.ledger.rules, autoApproveThresholdKopecks: 1_000_000 };
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 350_000 }),
      );

      expect(result).toMatchObject({
        outcome: 'held',
        screen: 'credited',
        pointsAwarded: 105,
        pointsAvailableAt: '2026-01-22T10:00:00.000Z',
        balance: { available: 0, pending: 105 },
      });
      expect(result.message).toContain('22.01.2026');
      expect(h.ledger.entries[0]).toMatchObject({
        state: 'pending',
        amount: 105,
        availableAt: new Date('2026-01-22T10:00:00.000Z'),
        expiresAt: new Date('2027-01-22T10:00:00.000Z'),
      });
      expect(h.outbox.ofType(RECEIPT_EVENTS.credited)[0]!.payload).toMatchObject({
        pointsState: 'pending',
        availableAt: '2026-01-22T10:00:00.000Z',
      });
    });

    it('sends a receipt above the auto-approve threshold to moderation', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(45 * MINUTE), totalKopecks: 1_250_000 }),
      );

      expect(result).toMatchObject({
        outcome: 'needs_moderation',
        screen: 'pending',
        title: 'Чек на перевірці',
        pointsAwarded: null,
        moderationReasons: ['Сума понад 1 000 ₴'],
        balance: null,
      });
      expect(result.message).toContain('24 год');
      expect(result.receipt.status).toBe('needs_moderation');
      expect(h.ledger.countWrites()).toBe(0);
      expect(h.outbox.types()).toEqual([RECEIPT_EVENTS.submitted, RECEIPT_EVENTS.needsModeration]);
      expect(h.outbox.ofType(RECEIPT_EVENTS.needsModeration)[0]!.payload).toMatchObject({
        riskFlags: ['high_total'],
        riskScore: 40,
        tenantId: INTERTOP_ID,
      });
      expect(h.repo.events.at(-1)?.note).toBe('moderation: total_above_threshold');
      expect(h.repo.receipts[0]).toMatchObject({
        moderationReasons: ['total_above_threshold'],
        rejectionCode: null,
      });
    });

    it('records an unknown cash register in content and moderates the receipt', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ fn: UNKNOWN_FN, issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );

      expect(result.screen).toBe('pending');
      expect(result.moderationReasons).toEqual(['Каса ще не підтверджена в програмі']);
      expect(result.receipt.tenant).toBeNull();
      expect(h.content.fiscalNumber(UNKNOWN_FN)).toMatchObject({
        status: 'pending',
        source: 'receipt',
        seenOnReceiptId: result.receipt.id,
      });
      expect(h.repo.receipts[0]).toMatchObject({ riskFlags: ['fn_unknown'], riskScore: 60 });
    });

    it('rejects a duplicate (fn, fiscalId) with 409 and tells only the owner which receipt', async () => {
      const qr = taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000, fiscalId: 'DUP-1' });
      const first = await h.submission.submitQr(MEMBER, qr);

      const own = await expectDomainError(
        h.submission.submitQr(MEMBER, qr),
        'PC_RECEIPT_DUPLICATE',
        409,
      );
      expect(own.message).toBe('Цей чек уже зареєстровано в програмі.');
      expect(own.details).toEqual({ receiptId: first.receipt.id, status: 'credited' });

      const foreign = await expectDomainError(
        h.submission.submitQr(OTHER_MEMBER, qr),
        'PC_RECEIPT_DUPLICATE',
      );
      expect(foreign.details).toEqual({ receiptId: null });
      expect(h.repo.receipts).toHaveLength(1);
      expect(h.ledger.countWrites()).toBe(1);
    });

    it('turns a unique violation from a concurrent submission into PC_RECEIPT_DUPLICATE', async () => {
      const qr = taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000, fiscalId: 'RACE-1' });
      await h.submission.submitQr(OTHER_MEMBER, qr);
      jest.spyOn(h.repo, 'findByFnAndFiscalId').mockResolvedValueOnce(null);

      await expectDomainError(h.submission.submitQr(MEMBER, qr), 'PC_RECEIPT_DUPLICATE', 409);
      expect(h.repo.receipts).toHaveLength(1);
      expect(h.prisma.rollbacks).toBe(1);
    });

    it('stores the receipt without the device when the token device no longer exists', async () => {
      const create = h.repo.create.bind(h.repo);
      jest.spyOn(h.repo, 'create').mockImplementationOnce(async () => {
        throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
          code: 'P2003',
          clientVersion: 'test',
        });
      });
      jest.spyOn(h.repo, 'create').mockImplementation(create);

      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(result.outcome).toBe('credited');
      expect(h.repo.receipts[0]!.deviceId).toBeNull();
      expect(h.outbox.ofType(RECEIPT_EVENTS.submitted)[0]!.payload).toMatchObject({
        deviceId: null,
      });
    });

    it('rejects a receipt older than the upload window with PC_RECEIPT_TOO_OLD', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(8 * DAY), totalKopecks: 50_000 }),
      );

      expect(result).toMatchObject({
        outcome: 'rejected',
        screen: 'rejected',
        title: 'Чек відхилено',
        rejectionCode: 'PC_RECEIPT_TOO_OLD',
        pointsAwarded: null,
      });
      expect(result.message).toMatch(/^Відхилено: чек подано пізніше/);
      expect(result.message).toContain('оскаржте');
      expect(result.receipt).toMatchObject({ status: 'rejected', canAppeal: true });
      expect(result.receipt.decisionReason).toBe(
        'Чек подано пізніше за дозволене вікно завантаження',
      );
      expect(h.repo.receipts[0]).toMatchObject({
        rejectionCode: 'PC_RECEIPT_TOO_OLD',
        moderationReasons: [],
      });
      expect(h.outbox.ofType(RECEIPT_EVENTS.rejected)[0]!.payload).toMatchObject({
        moderatorId: null,
        code: 'PC_RECEIPT_TOO_OLD',
      });
      expect(h.ledger.countWrites()).toBe(0);
    });

    it('rejects a receipt dated more than 10 minutes in the future with PC_RECEIPT_FUTURE', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: new Date(NOW.getTime() + HOUR), totalKopecks: 50_000 }),
      );
      expect(result).toMatchObject({ outcome: 'rejected', rejectionCode: 'PC_RECEIPT_FUTURE' });
      expect(result.message).toContain('дата і час чека ще не настали');
    });

    it('rejects a receipt from an excluded tenant with PC_RECEIPT_EXCLUDED_TENANT', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ fn: TAMTAM_FN, issuedAt: ago(HOUR), totalKopecks: 42_000 }),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        screen: 'rejected',
        rejectionCode: 'PC_RECEIPT_EXCLUDED_TENANT',
      });
      expect(result.message).toContain('магазин не бере участі в програмі лояльності');
      expect(result.receipt.tenant).toMatchObject({ name: 'ТамТам' });
    });

    it('moderates the receipt once the daily receipt limit (Kyiv day) is reached', async () => {
      for (let index = 0; index < 10; index += 1) {
        h.repo.insert({
          id: `00000000-0000-7000-8000-0000000000${String(index).padStart(2, '0')}`,
          userId: MEMBER.userId,
          fn: INTERTOP_FN,
          fiscalId: `TODAY-${index}`,
          submittedAt: ago(HOUR + index * MINUTE),
        });
      }
      // Yesterday's receipts (before 00:00 Kyiv) do not count.
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000099',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'YESTERDAY',
        submittedAt: new Date('2026-01-14T21:59:00.000Z'),
      });

      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(10 * MINUTE), totalKopecks: 50_000 }),
      );
      expect(result.screen).toBe('pending');
      expect(result.moderationReasons).toEqual(['Перевищено денний ліміт чеків (10)']);
    });

    it('lets the tenth receipt of the day through', async () => {
      for (let index = 0; index < 9; index += 1) {
        h.repo.insert({
          id: `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
          userId: MEMBER.userId,
          fn: INTERTOP_FN,
          fiscalId: `NINE-${index}`,
          submittedAt: ago(2 * HOUR),
        });
      }
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(10 * MINUTE), totalKopecks: 50_000 }),
      );
      expect(result.outcome).toBe('credited');
    });

    it('moderates a burst of receipts from the same cash register', async () => {
      for (let index = 0; index < 3; index += 1) {
        h.repo.insert({
          id: `00000000-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`,
          userId: MEMBER.userId,
          fn: INTERTOP_FN,
          fiscalId: `BURST-${index}`,
          submittedAt: ago(5 * MINUTE),
        });
      }
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(20 * MINUTE), totalKopecks: 50_000 }),
      );
      expect(result.moderationReasons).toEqual(['Кілька чеків з однієї каси за короткий час']);
    });

    it('flags a device shared with another member without blocking the credit', async () => {
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000300',
        userId: OTHER_MEMBER.userId,
        deviceId: MEMBER.deviceId,
        fn: INTERTOP_FN,
        fiscalId: 'SHARED-1',
        submittedAt: ago(2 * HOUR),
      });
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(result.outcome).toBe('credited');
      const stored = h.repo.receipts.find((row) => row.id === result.receipt.id);
      expect(stored).toMatchObject({ riskFlags: ['device_shared'], riskScore: 30 });
    });

    it('applies the tenant daily points cap and credits 0 points once it is exhausted', async () => {
      h.content.rules.set(INTERTOP_ID, {
        tenantId: INTERTOP_ID,
        ratePercent: null,
        minTotalKopecks: 0,
        dailyCapPoints: 20,
        source: 'rule',
      });
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000400',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'CAP-1',
        tenantId: INTERTOP_ID,
        status: 'credited',
        pointsAwarded: 15,
        submittedAt: ago(HOUR),
      });

      const partial = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(30 * MINUTE), totalKopecks: 50_000 }),
      );
      expect(partial.pointsAwarded).toBe(5);

      // 510 UAH: not a round total, so only the tenant cap is in play.
      const none = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(20 * MINUTE), totalKopecks: 51_000 }),
      );
      expect(none).toMatchObject({ outcome: 'credited', screen: 'credited', pointsAwarded: 0 });
      expect(none.message).toContain('денний ліміт балів');
      expect(h.ledger.entries).toHaveLength(1);
      expect(h.outbox.ofType(RECEIPT_EVENTS.credited)).toHaveLength(1);
    });

    it('answers 400 PC_RECEIPT_QR_INVALID with a Ukrainian message for garbage', async () => {
      const error = await expectDomainError(
        h.submission.submitQr(MEMBER, 'https://example.com/not-a-receipt'),
        'PC_RECEIPT_QR_INVALID',
        400,
      );
      expect(error.message).toContain('Це не QR-код фіскального чека');
      expect(error.details).toEqual({ reason: 'NOT_A_TAX_URL', param: null });

      const missing = await expectDomainError(
        h.submission.submitQr(
          MEMBER,
          'https://cabinet.tax.gov.ua/cashregs/check?fn=4000100011&date=20260115&time=1200&sm=1.00',
        ),
        'PC_RECEIPT_QR_INVALID',
      );
      expect(missing.details).toEqual({ reason: 'MISSING_PARAM', param: 'id' });
      expect(h.repo.receipts).toHaveLength(0);
    });

    it('keeps the receipt approved and queues receipts-process when the ledger fails', async () => {
      h.ledger.failNext('credit');
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );

      expect(result).toMatchObject({ outcome: 'processing', screen: 'pending' });
      expect(result.message).toContain('бали нараховуються');
      expect(result.receipt.status).toBe('auto_approved');
      expect(h.ledger.entries).toHaveLength(0);
      expect(h.outbox.types()).toEqual([RECEIPT_EVENTS.submitted]);
      expect(h.queueBackend.jobs).toEqual([
        expect.objectContaining({
          name: 'process',
          id: `receipt-${result.receipt.id}-submit`,
          data: { receiptId: result.receipt.id },
          opts: expect.objectContaining({
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
          }),
        }),
      ]);

      // The job retries the same pipeline: credited exactly once, with the same ledger key.
      const retried = await h.pipeline.process(result.receipt.id);
      expect(retried.receipt.status).toBe('credited');
      expect(h.ledger.entries).toHaveLength(1);
      expect(h.ledger.entries[0]!.idempotencyKey).toBe(receiptLedgerKey(result.receipt.id));
    });

    it('keeps the receipt parsed and queues it when content is unavailable', async () => {
      h.content.failLookups = true;
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      expect(result.receipt.status).toBe('parsed');
      expect(result.screen).toBe('pending');
      expect(h.queueBackend.jobs).toHaveLength(1);

      h.content.failLookups = false;
      const retried = await h.pipeline.process(result.receipt.id);
      expect(retried.receipt.status).toBe('credited');
    });

    it('is idempotent: re-running the pipeline on a credited receipt changes nothing', async () => {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      const eventsBefore = h.repo.events.length;
      const outboxBefore = h.outbox.events.length;

      const again = await h.pipeline.process(result.receipt.id);
      await h.pipeline.process(result.receipt.id);

      expect(again).toMatchObject({ decision: null, credit: null });
      expect(again.receipt.status).toBe('credited');
      expect(h.ledger.countWrites()).toBe(1);
      expect(h.repo.events).toHaveLength(eventsBefore);
      expect(h.outbox.events).toHaveLength(outboxBefore);
    });
  });

  describe('POST /receipts/manual', () => {
    it('stores a manual receipt with its photo and always moderates it', async () => {
      const photoKey = await h.uploadPhoto();
      const result = await h.submission.submitManual(MEMBER, {
        fn: INTERTOP_FN,
        fiscalId: 'MAN-1',
        issuedAt: '2026-01-15T11:30:00',
        totalKopecks: 42_000,
        photoKey,
      });

      expect(result).toMatchObject({
        outcome: 'needs_moderation',
        screen: 'pending',
        moderationReasons: ['Чек без QR-коду перевіряє модератор'],
      });
      expect(result.receipt).toMatchObject({
        source: 'manual',
        status: 'needs_moderation',
        // 11:30 Kyiv wall clock (UTC+2 in January).
        issuedAt: '2026-01-15T09:30:00.000Z',
      });
      expect(h.repo.receipts[0]).toMatchObject({ photoKey, rawQr: null });
      expect(h.repo.events[0]?.note).toBe('submitted manually with a photo');
      expect(h.ledger.countWrites()).toBe(0);
    });

    it('accepts an issuedAt with an explicit offset', async () => {
      const photoKey = await h.uploadPhoto();
      const result = await h.submission.submitManual(MEMBER, {
        fn: INTERTOP_FN,
        fiscalId: 'MAN-2',
        issuedAt: '2026-01-15T11:30:00+02:00',
        totalKopecks: 42_000,
        photoKey,
      });
      expect(result.receipt.issuedAt).toBe('2026-01-15T09:30:00.000Z');
    });

    it('still applies rejection rules to manual receipts', async () => {
      const photoKey = await h.uploadPhoto();
      const result = await h.submission.submitManual(MEMBER, {
        fn: INTERTOP_FN,
        fiscalId: 'MAN-OLD',
        issuedAt: '2026-01-01T12:00:00',
        totalKopecks: 42_000,
        photoKey,
      });
      expect(result).toMatchObject({ outcome: 'rejected', rejectionCode: 'PC_RECEIPT_TOO_OLD' });
    });

    it('requires the photo to be uploaded first (PC_RECEIPT_PHOTO_REQUIRED)', async () => {
      const upload = await h.submission.createPhotoUploadUrl(MEMBER.userId, {
        contentType: 'image/jpeg',
        sizeBytes: 1_000,
      });
      await expectDomainError(
        h.submission.submitManual(MEMBER, {
          fn: INTERTOP_FN,
          fiscalId: 'MAN-3',
          issuedAt: '2026-01-15T11:30:00',
          totalKopecks: 42_000,
          photoKey: upload.key,
        }),
        'PC_RECEIPT_PHOTO_REQUIRED',
        422,
      );
      expect(h.repo.receipts).toHaveLength(0);
    });

    it('refuses a photo uploaded by another member (PC_RECEIPT_PHOTO_INVALID)', async () => {
      const foreignKey = await h.uploadPhoto(OTHER_MEMBER);
      const error = await expectDomainError(
        h.submission.submitManual(MEMBER, {
          fn: INTERTOP_FN,
          fiscalId: 'MAN-4',
          issuedAt: '2026-01-15T11:30:00',
          totalKopecks: 42_000,
          photoKey: foreignKey,
        }),
        'PC_RECEIPT_PHOTO_INVALID',
      );
      expect(error.details).toMatchObject({ problem: 'foreign_key' });
    });

    it('accepts a shop without the cash register number; the moderator fills fn in', async () => {
      const photoKey = await h.uploadPhoto();
      const result = await h.submission.submitManual(MEMBER, {
        tenantId: INTERTOP_ID,
        fiscalId: '0042-17',
        issuedAt: '2026-01-15T11:30:00',
        totalKopecks: 42_050,
        photoKey,
      });
      expect(result).toMatchObject({
        outcome: 'needs_moderation',
        receipt: {
          fn: null,
          fiscalId: '4217',
          tenant: { id: INTERTOP_ID },
          expectedPoints: 12,
        },
      });
      expect(h.repo.receipts[0]).toMatchObject({
        fn: null,
        fnRaw: null,
        fiscalIdRaw: '0042-17',
        tenantId: INTERTOP_ID,
      });
      expect(h.outbox.ofType(RECEIPT_EVENTS.submitted)[0]!.payload).toMatchObject({ fn: '' });
      // Nothing to map: no cash register was given.
      expect(h.content.fiscalNumber('')).toBeUndefined();

      await expectDomainError(
        h.moderation.approve(MODERATOR, result.receipt.id, {}),
        'PC_COMMON_VALIDATION',
        400,
      );
      const approved = await h.moderation.approve(MODERATOR, result.receipt.id, {
        fn: ` 0${INTERTOP_FN} `,
      });
      expect(approved).toMatchObject({
        status: 'credited',
        fn: INTERTOP_FN,
        pointsAwarded: 12,
        tenant: { id: INTERTOP_ID },
      });
      expect(h.repo.events.find((event) => event.toStatus === 'approved')?.note).toContain(
        `fn ${INTERTOP_FN} filled in`,
      );
    });

    it('detects the duplicate when the moderator completes the number', async () => {
      await h.submission.submitQr(
        OTHER_MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 43_210, fiscalId: '777' }),
      );
      const photoKey = await h.uploadPhoto();
      const result = await h.submission.submitManual(MEMBER, {
        tenantId: INTERTOP_ID,
        fiscalId: '0777',
        issuedAt: '2026-01-15T11:30:00',
        totalKopecks: 43_210,
        photoKey,
      });
      expect(result.outcome).toBe('needs_moderation');
      await expectDomainError(
        h.moderation.approve(MODERATOR, result.receipt.id, { fn: INTERTOP_FN }),
        'PC_RECEIPT_DUPLICATE',
        409,
      );
      expect(h.repo.receipts.find((row) => row.id === result.receipt.id)).toMatchObject({
        status: 'needs_moderation',
        fn: null,
      });
    });

    it('maps an unknown cash register given by the moderator to the whitelist queue', async () => {
      const photoKey = await h.uploadPhoto();
      const result = await h.submission.submitManual(MEMBER, {
        tenantId: INTERTOP_ID,
        fiscalId: 'X-1',
        issuedAt: '2026-01-15T11:30:00',
        totalKopecks: 42_050,
        photoKey,
      });
      await h.moderation.approve(MODERATOR, result.receipt.id, { fn: UNKNOWN_FN });
      expect(h.content.fiscalNumber(UNKNOWN_FN)).toMatchObject({
        status: 'pending',
        seenOnReceiptId: result.receipt.id,
      });
    });

    it('requires fn when no shop is chosen ("Не знаю") and validates the shop', async () => {
      const photoKey = await h.uploadPhoto();
      const missing = await expectDomainError(
        h.submission.submitManual(MEMBER, {
          tenantId: null,
          fiscalId: 'MAN-6',
          issuedAt: '2026-01-15T11:30:00',
          totalKopecks: 42_000,
          photoKey,
        }),
        'PC_COMMON_VALIDATION',
        400,
      );
      expect(missing.details).toEqual({ field: 'fn', reason: 'required_without_tenant' });

      const unknownShop = await expectDomainError(
        h.submission.submitManual(MEMBER, {
          tenantId: '0192f3a0-0000-7000-8000-0000000000ff',
          fiscalId: 'MAN-7',
          issuedAt: '2026-01-15T11:30:00',
          totalKopecks: 42_000,
          photoKey,
        }),
        'PC_COMMON_VALIDATION',
      );
      expect(unknownShop.details).toEqual({ field: 'tenantId', reason: 'not_found' });

      const badFn = await expectDomainError(
        h.submission.submitManual(MEMBER, {
          fn: '0000012345',
          fiscalId: 'MAN-8',
          issuedAt: '2026-01-15T11:30:00',
          totalKopecks: 42_000,
          photoKey,
        }),
        'PC_COMMON_VALIDATION',
      );
      expect(badFn.details).toEqual({ field: 'fn' });
      expect(h.repo.receipts).toHaveLength(0);
    });

    it('stores canonical numbers of a manual receipt with fn and "Не знаю"', async () => {
      const photoKey = await h.uploadPhoto();
      const result = await h.submission.submitManual(MEMBER, {
        fn: `00${INTERTOP_FN}`,
        fiscalId: ' ab-0012 ',
        issuedAt: '2026-01-15T11:30:00',
        totalKopecks: 42_000,
        photoKey,
      });
      expect(result.receipt).toMatchObject({
        fn: INTERTOP_FN,
        fiscalId: 'AB0012',
        tenant: { id: INTERTOP_ID },
      });
      expect(h.repo.receipts[0]).toMatchObject({
        fnRaw: `00${INTERTOP_FN}`,
        fiscalIdRaw: 'ab-0012',
      });
    });

    it('is switched off by the receipts.manual_submission feature flag', async () => {
      h.flags.values.set('receipts.manual_submission', false);
      const photoKey = await h.uploadPhoto();
      await expectDomainError(
        h.submission.submitManual(MEMBER, {
          fn: INTERTOP_FN,
          fiscalId: 'MAN-5',
          issuedAt: '2026-01-15T11:30:00',
          totalKopecks: 42_000,
          photoKey,
        }),
        'PC_RECEIPT_MANUAL_DISABLED',
        403,
      );
    });
  });

  describe('GET /receipts and GET /receipts/:id', () => {
    it('lists only the member own receipts, newest first, with a cursor', async () => {
      for (let index = 0; index < 3; index += 1) {
        h.clock.advanceMinutes(1);
        await h.submission.submitQr(
          MEMBER,
          taxQr({
            issuedAt: ago(HOUR),
            totalKopecks: 50_000 + index * 1_000,
            fiscalId: `L-${index}`,
          }),
        );
      }
      await h.submission.submitQr(
        OTHER_MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000, fiscalId: 'L-OTHER' }),
      );

      // Receipt numbers are stored in their canonical form (no dashes).
      const first = await h.submission.list(MEMBER.userId, { limit: 2 });
      expect(first.items.map((item) => item.fiscalId)).toEqual(['L2', 'L1']);
      expect(first.nextCursor).not.toBeNull();
      const second = await h.submission.list(MEMBER.userId, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((item) => item.fiscalId)).toEqual(['L0']);
      expect(second.nextCursor).toBeNull();

      const rejected = await h.submission.list(MEMBER.userId, { limit: 20, status: 'rejected' });
      expect(rejected.items).toHaveLength(0);
    });

    it('returns the detail with points, history and moderation reasons; 404 for others', async () => {
      const moderated = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 1_250_000 }),
      );
      const detail = await h.submission.get(MEMBER.userId, moderated.receipt.id);
      expect(detail).toMatchObject({
        status: 'needs_moderation',
        moderationReasons: ['Сума понад 1 000 ₴'],
        rejectionCode: null,
        points: null,
        photoUrl: null,
        appeals: [],
      });
      expect(detail.events.map((event) => event.toStatus)).toEqual([
        'uploaded',
        'parsed',
        'needs_moderation',
      ]);

      // 499.50 UAH: not a round total (a second one would go to moderation) and within the
      // fast-track limit (no verification hold).
      const credited = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 49_950 }),
      );
      const creditedDetail = await h.submission.get(MEMBER.userId, credited.receipt.id);
      expect(creditedDetail.points).toMatchObject({ awarded: 14, state: 'available' });

      await expectDomainError(
        h.submission.get(OTHER_MEMBER.userId, moderated.receipt.id),
        'PC_RECEIPT_NOT_FOUND',
        404,
      );
    });

    it('shows expectedPoints for receipts in moderation or processing only', async () => {
      const moderated = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 1_250_000 }),
      );
      expect(moderated.receipt.expectedPoints).toBe(375);
      const credited = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_050 }),
      );
      expect(credited.receipt.expectedPoints).toBeNull();
      const rejected = await h.submission.submitQr(
        MEMBER,
        taxQr({ fn: TAMTAM_FN, issuedAt: ago(HOUR), totalKopecks: 42_000 }),
      );
      expect(rejected.receipt.expectedPoints).toBeNull();

      const page = await h.submission.list(MEMBER.userId, { limit: 20 });
      expect(
        Object.fromEntries(page.items.map((item) => [item.status, item.expectedPoints])),
      ).toEqual({ needs_moderation: 375, credited: null, rejected: null });
      const detail = await h.submission.get(MEMBER.userId, moderated.receipt.id);
      expect(detail.expectedPoints).toBe(375);

      // Excluded or closed shops would earn nothing.
      h.content.tenants.set(INTERTOP_ID, {
        ...h.content.tenants.get(INTERTOP_ID)!,
        excludedFromProgram: true,
      });
      expect((await h.submission.get(MEMBER.userId, moderated.receipt.id)).expectedPoints).toBe(0);
    });

    it('filters my receipts by submission time (from inclusive, to exclusive)', async () => {
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000801',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'FROM1',
        submittedAt: new Date('2026-01-10T10:00:00.000Z'),
      });
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000802',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'FROM2',
        submittedAt: new Date('2026-01-12T10:00:00.000Z'),
      });
      h.repo.insert({
        id: '00000000-0000-7000-8000-000000000803',
        userId: MEMBER.userId,
        fn: INTERTOP_FN,
        fiscalId: 'FROM3',
        submittedAt: new Date('2026-01-14T10:00:00.000Z'),
      });
      const page = await h.submission.list(MEMBER.userId, {
        limit: 20,
        from: '2026-01-12T10:00:00.000Z',
        to: '2026-01-14T10:00:00.000Z',
      });
      expect(page.items.map((item) => item.fiscalId)).toEqual(['FROM2']);
    });

    it('keeps the rule rejection code on the detail view', async () => {
      const rejected = await h.submission.submitQr(
        MEMBER,
        taxQr({ fn: TAMTAM_FN, issuedAt: ago(HOUR), totalKopecks: 42_000 }),
      );
      const detail = await h.submission.get(MEMBER.userId, rejected.receipt.id);
      expect(detail).toMatchObject({
        rejectionCode: 'PC_RECEIPT_EXCLUDED_TENANT',
        canAppeal: true,
      });
    });
  });

  describe('POST /receipts/:id/appeal', () => {
    async function rejectedReceipt(): Promise<string> {
      const result = await h.submission.submitQr(
        MEMBER,
        taxQr({ fn: TAMTAM_FN, issuedAt: ago(HOUR), totalKopecks: 42_000 }),
      );
      return result.receipt.id;
    }

    it('moves a rejected receipt to appealed and publishes receipt.appealed', async () => {
      const receiptId = await rejectedReceipt();
      const photoKey = await h.uploadPhoto();
      const detail = await h.submission.appeal(MEMBER, receiptId, {
        message: '  Купував у кафе на фудкорті, не в ТамТам  ',
        photoKey,
      });

      expect(detail).toMatchObject({ status: 'appealed', canAppeal: false });
      expect(detail.appeals).toEqual([
        expect.objectContaining({
          message: 'Купував у кафе на фудкорті, не в ТамТам',
          resolvedAt: null,
        }),
      ]);
      expect(h.repo.appeals[0]).toMatchObject({ receiptId, photoKey });
      expect(h.repo.events.at(-1)).toMatchObject({
        fromStatus: 'rejected',
        toStatus: 'appealed',
        actorType: 'user',
        actorId: MEMBER.userId,
      });
      expect(h.outbox.ofType(RECEIPT_EVENTS.appealed)[0]!.payload).toEqual({
        receiptId,
        userId: MEMBER.userId,
        appealId: h.repo.appeals[0]!.id,
        previousStatus: 'rejected',
      });
    });

    it('refuses to appeal a receipt that is not rejected', async () => {
      const credited = await h.submission.submitQr(
        MEMBER,
        taxQr({ issuedAt: ago(HOUR), totalKopecks: 50_000 }),
      );
      await expectDomainError(
        h.submission.appeal(MEMBER, credited.receipt.id, { message: 'Хочу ще балів' }),
        'PC_RECEIPT_APPEAL_NOT_ALLOWED',
        422,
      );
    });

    it('allows a single appeal per receipt', async () => {
      const receiptId = await rejectedReceipt();
      await h.submission.appeal(MEMBER, receiptId, { message: 'Перевірте, будь ласка' });
      await h.moderation.reject(MODERATOR, receiptId, { reason: 'Чек справді з ТамТам' });

      const error = await expectDomainError(
        h.submission.appeal(MEMBER, receiptId, { message: 'Ще раз прошу' }),
        'PC_RECEIPT_APPEAL_NOT_ALLOWED',
      );
      expect(error.details).toEqual({ status: 'rejected', appealsSoFar: 1 });
      const detail = await h.submission.get(MEMBER.userId, receiptId);
      expect(detail.canAppeal).toBe(false);
    });

    it('hides other members receipts behind 404', async () => {
      const receiptId = await rejectedReceipt();
      await expectDomainError(
        h.submission.appeal(OTHER_MEMBER, receiptId, { message: 'Не мій чек' }),
        'PC_RECEIPT_NOT_FOUND',
      );
    });
  });
});
