import {
  DISPLAY_SUBTITLE_MAX,
  DISPLAY_TITLE_MAX,
  defaultPointsTitle,
  normalizeCounterparty,
  resolvePointsDisplay,
} from './display';

const UUID = '0192f3a0-6c3e-7d2a-9c1b-000000000001';

describe('points history display data', () => {
  it.each([
    ['earn', 'receipt', 180, 'Нарахування за чек'],
    ['earn', 'promo', 10, 'Нарахування балів'],
    ['welcome', 'system', 50, 'Бонус'],
    ['spend', 'redemption', -60, 'Обмін на винагороду'],
    ['spend', 'parking', -40, 'Списання балів'],
    ['adjust', 'manual', 30, 'Нарахування від ТРЦ'],
    ['adjust', 'manual', -30, 'Списання балів'],
    ['expire', 'system', -10, 'Бали згоріли'],
    ['refund', 'redemption', 60, 'Повернення балів'],
    ['reverse', 'receipt', -180, 'Скасування нарахування'],
  ] as const)('default title of %s/%s (%i) is "%s"', (type, sourceType, amount, title) => {
    expect(defaultPointsTitle(type, sourceType, amount)).toBe(title);
  });

  it('keeps the caller values, trimmed and clipped to the column sizes', () => {
    const display = resolvePointsDisplay(
      {
        title: `  ${'т'.repeat(DISPLAY_TITLE_MAX + 5)}  `,
        subtitle: 's'.repeat(DISPLAY_SUBTITLE_MAX + 1),
        counterparty: { tenantName: ' INTERTOP ', receiptTotalKopecks: 600_000, receiptId: UUID },
      },
      'fallback',
    );
    expect(display.title).toHaveLength(DISPLAY_TITLE_MAX);
    expect(display.subtitle).toHaveLength(DISPLAY_SUBTITLE_MAX);
    expect(display.counterparty).toEqual({
      tenantName: 'INTERTOP',
      receiptTotalKopecks: 600_000,
      receiptId: UUID,
    });
  });

  it('falls back to the derived title when the caller sends none or blanks', () => {
    expect(resolvePointsDisplay(undefined, 'Нарахування за чек')).toEqual({
      title: 'Нарахування за чек',
      subtitle: null,
      counterparty: null,
    });
    expect(resolvePointsDisplay({ title: '   ', subtitle: '' }, 'X', 'Y')).toEqual({
      title: 'X',
      subtitle: 'Y',
      counterparty: null,
    });
  });

  it('drops unknown or malformed counterparty fields', () => {
    expect(
      normalizeCounterparty({
        tenantId: 'not-a-uuid',
        receiptTotalKopecks: -5,
        rewardTitle: '',
        voucherId: UUID,
        ...({ password: 'x' } as object),
      }),
    ).toEqual({ voucherId: UUID });
    expect(normalizeCounterparty({ receiptTotalKopecks: 1.5 })).toBeNull();
    expect(normalizeCounterparty(null)).toBeNull();
  });
});
