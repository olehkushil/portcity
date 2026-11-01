import { DEFAULT_LOYALTY_RULES } from '../../../common/contracts/club';
import type { ReceiptStatus } from '../../../common/contracts/receipts';
import { MODERATION_REASONS } from './rules';
import {
  QR_ERROR_MESSAGES_UK,
  type SubmissionViewInput,
  buildSubmissionView,
  moderationReasonText,
  parseModerationReasons,
  parseRejectionCode,
} from './submission-view';

function input(overrides: Partial<SubmissionViewInput> = {}): SubmissionViewInput {
  return {
    status: 'credited',
    pointsAwarded: 120,
    pointsState: 'available',
    pointsAvailableAt: null,
    rejectionCode: null,
    decisionReason: null,
    moderationReasons: [],
    rules: DEFAULT_LOYALTY_RULES,
    ...overrides,
  };
}

describe('buildSubmissionView', () => {
  it('credited: prototype scan-result', () => {
    expect(buildSubmissionView(input())).toEqual({
      outcome: 'credited',
      screen: 'credited',
      title: 'Чек зараховано',
      message: 'Нараховано +120 балів. Бали вже можна обміняти на винагороди.',
      pointsAwarded: 120,
      pointsAvailableAt: null,
      rejectionCode: null,
      moderationReasons: [],
    });
  });

  it('held: credited screen with the Kyiv date of availability', () => {
    const at = new Date('2026-01-22T10:00:00.000Z');
    const view = buildSubmissionView(
      input({ pointsAwarded: 1, pointsState: 'pending', pointsAvailableAt: at }),
    );
    expect(view).toMatchObject({ outcome: 'held', screen: 'credited', pointsAvailableAt: at });
    expect(view.message).toBe('Нараховано +1 бал. Бали стануть доступні 22.01.2026.');
  });

  it('credited with zero points explains the tenant cap', () => {
    const view = buildSubmissionView(input({ pointsAwarded: 0, pointsState: null }));
    expect(view).toMatchObject({ outcome: 'credited', screen: 'credited', pointsAwarded: 0 });
    expect(view.message).toContain('денний ліміт балів');
  });

  it('pending: prototype scan-pending with the reasons', () => {
    const view = buildSubmissionView(
      input({
        status: 'needs_moderation',
        pointsAwarded: null,
        pointsState: null,
        moderationReasons: ['total_above_threshold', 'manual_submission'],
      }),
    );
    expect(view).toMatchObject({
      outcome: 'needs_moderation',
      screen: 'pending',
      title: 'Чек на перевірці',
      pointsAwarded: null,
      moderationReasons: ['Сума понад 1 000 ₴', 'Чек без QR-коду перевіряє модератор'],
    });
    expect(view.message).toContain('відповімо до 24 год');
  });

  it.each<ReceiptStatus>(['parsed', 'auto_approved', 'approved', 'uploaded'])(
    '%s (credit still running) is processing on the pending screen without reasons',
    (status) => {
      const view = buildSubmissionView(
        input({ status, moderationReasons: ['fn_not_whitelisted'], pointsState: null }),
      );
      expect(view).toMatchObject({
        outcome: 'processing',
        screen: 'pending',
        moderationReasons: [],
        pointsAwarded: null,
      });
      expect(view.message).toContain('бали нараховуються');
    },
  );

  it('rejected: prototype scan-rejected with the reason and the appeal hint', () => {
    const view = buildSubmissionView(
      input({
        status: 'rejected',
        pointsAwarded: null,
        rejectionCode: 'PC_RECEIPT_EXCLUDED_TENANT',
        decisionReason: 'Магазин не бере участі в програмі лояльності',
      }),
    );
    expect(view).toMatchObject({
      outcome: 'rejected',
      screen: 'rejected',
      title: 'Чек відхилено',
      rejectionCode: 'PC_RECEIPT_EXCLUDED_TENANT',
      pointsAwarded: null,
    });
    expect(view.message).toBe(
      'Відхилено: магазин не бере участі в програмі лояльності. Якщо вважаєте, що це помилка, оскаржте — перевіримо вручну до 24 год.',
    );
  });

  it('keeps acronyms in moderator reasons and falls back to a default reason', () => {
    const acronym = buildSubmissionView(
      input({ status: 'rejected', decisionReason: 'INTERTOP не видавав цей чек.' }),
    );
    expect(acronym.message).toMatch(/^Відхилено: INTERTOP не видавав цей чек\. /);
    const empty = buildSubmissionView(input({ status: 'rejected', decisionReason: '  ' }));
    expect(empty.message).toMatch(/^Відхилено: чек не відповідає правилам програми\. /);
  });
});

describe('moderation reason texts', () => {
  it('has a Ukrainian line for every reason', () => {
    for (const reason of MODERATION_REASONS) {
      expect(moderationReasonText(reason, DEFAULT_LOYALTY_RULES).length).toBeGreaterThan(5);
    }
    expect(
      moderationReasonText('total_above_threshold', {
        ...DEFAULT_LOYALTY_RULES,
        autoApproveThresholdKopecks: 250_050,
      }),
    ).toBe('Сума понад 2 500,50 ₴');
    expect(moderationReasonText('daily_limit_reached', DEFAULT_LOYALTY_RULES)).toBe(
      'Перевищено денний ліміт чеків (10)',
    );
  });
});

describe('persisted decision details', () => {
  it('reads the moderation_reasons column, dropping unknown or repeated values', () => {
    expect(parseModerationReasons(['manual_submission', 'total_above_threshold'])).toEqual([
      'manual_submission',
      'total_above_threshold',
    ]);
    expect(parseModerationReasons(['bogus', 'same_fn_burst', 'same_fn_burst', 7])).toEqual([
      'same_fn_burst',
    ]);
    expect(parseModerationReasons({ reason: 'manual_submission' })).toEqual([]);
    expect(parseModerationReasons(null)).toEqual([]);
  });

  it('accepts only rule rejection codes from the rejection_code column', () => {
    expect(parseRejectionCode('PC_RECEIPT_TOO_OLD')).toBe('PC_RECEIPT_TOO_OLD');
    // Set by the canonical fiscal id backfill and by a failed tax check during the hold.
    expect(parseRejectionCode('PC_RECEIPT_DUPLICATE')).toBe('PC_RECEIPT_DUPLICATE');
    expect(parseRejectionCode('PC_RECEIPT_NOT_VERIFIED')).toBe('PC_RECEIPT_NOT_VERIFIED');
    expect(parseRejectionCode('PC_RECEIPT_NOT_FOUND')).toBeNull();
    expect(parseRejectionCode(null)).toBeNull();
    expect(parseRejectionCode(undefined)).toBeNull();
  });
});

describe('member-facing messages', () => {
  it('has a Ukrainian message for every QR parse error', () => {
    expect(Object.keys(QR_ERROR_MESSAGES_UK).sort()).toEqual(
      ['BAD_DATE', 'BAD_SUM', 'MISSING_PARAM', 'NOT_A_TAX_URL'].sort(),
    );
  });
});
