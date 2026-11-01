import {
  HARNESS_NOW,
  MEMBER,
  OTHER_MEMBER,
  TAMTAM_FN,
  createReceiptsHarness,
  taxQr,
} from '../../../../test/receipts/support/receipts-harness';

const NOW = new Date(HARNESS_NOW);
const HOUR = 3_600_000;
const issuedAt = new Date(NOW.getTime() - HOUR);

describe('ReceiptsPortService (RECEIPTS_PORT)', () => {
  it('serves summaries, per-user counts and daily statistics', async () => {
    const h = createReceiptsHarness();
    const credited = await h.submission.submitQr(MEMBER, taxQr({ issuedAt, totalKopecks: 50_000 }));
    await h.submission.submitQr(MEMBER, taxQr({ issuedAt, totalKopecks: 1_250_000 }));
    await h.submission.submitQr(
      OTHER_MEMBER,
      taxQr({ fn: TAMTAM_FN, issuedAt, totalKopecks: 42_000 }),
    );

    const summary = await h.port.getReceipt(credited.receipt.id);
    expect(summary).toMatchObject({
      id: credited.receipt.id,
      userId: MEMBER.userId,
      status: 'credited',
      pointsAwarded: 15,
      riskFlags: [],
      issuedAt,
    });
    await expect(h.port.getReceipt('0192f3a0-9999-7000-8000-000000000000')).resolves.toBeNull();

    const day = {
      from: new Date('2026-01-14T22:00:00.000Z'),
      to: new Date('2026-01-15T22:00:00.000Z'),
    };
    await expect(h.port.countForUser(MEMBER.userId, day)).resolves.toBe(2);
    await expect(
      h.port.countForUser(MEMBER.userId, {
        from: day.to,
        to: new Date('2026-01-16T22:00:00.000Z'),
      }),
    ).resolves.toBe(0);

    await expect(h.port.getDailyStats(day)).resolves.toEqual({
      submitted: 3,
      byStatus: { credited: 1, needs_moderation: 1, rejected: 1 },
      pointsAwarded: 15,
    });
  });

  it('summarises unsettled receipts with the points they would earn', async () => {
    const h = createReceiptsHarness();
    await expect(h.port.getPendingSummary(MEMBER.userId)).resolves.toEqual({
      count: 0,
      expectedPoints: 0,
    });

    // needs_moderation: 12 500 UAH at 3 % = 375 points.
    await h.submission.submitQr(MEMBER, taxQr({ issuedAt, totalKopecks: 1_250_000 }));
    // processing: the credit failed and the receipt waits for the job (420.50 UAH = 12 points).
    h.ledger.failNext('credit');
    const processing = await h.submission.submitQr(
      MEMBER,
      taxQr({ issuedAt, totalKopecks: 42_050 }),
    );
    expect(processing.receipt.status).toBe('auto_approved');
    // Settled receipts do not count: credited and rejected.
    await h.submission.submitQr(MEMBER, taxQr({ issuedAt, totalKopecks: 10_050 }));
    await h.submission.submitQr(MEMBER, taxQr({ fn: TAMTAM_FN, issuedAt, totalKopecks: 42_000 }));
    // Another member's receipts are not mine.
    await h.submission.submitQr(OTHER_MEMBER, taxQr({ issuedAt, totalKopecks: 1_300_000 }));

    await expect(h.port.getPendingSummary(MEMBER.userId)).resolves.toEqual({
      count: 2,
      expectedPoints: 387,
    });
  });

  it('counts appealed receipts and still answers when the ledger is unavailable', async () => {
    const h = createReceiptsHarness();
    const rejected = await h.submission.submitQr(
      MEMBER,
      taxQr({ fn: TAMTAM_FN, issuedAt, totalKopecks: 42_000 }),
    );
    await h.submission.appeal(MEMBER, rejected.receipt.id, { message: 'Перевірте, будь ласка' });
    h.ledger.failNext('getActiveRules');
    // TamTam is excluded from the program: an appealed receipt is pending but earns nothing yet.
    await expect(h.port.getPendingSummary(MEMBER.userId)).resolves.toEqual({
      count: 1,
      expectedPoints: 0,
    });
  });
});
