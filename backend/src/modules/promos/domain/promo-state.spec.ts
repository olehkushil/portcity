import { PROMO_STATUSES, type PromoStatus } from '../../../common/contracts/promos';
import { DomainError } from '../../../common/errors/domain-error';
import { assertPromoTransition, canTransitionPromo, isPromoFinal } from './promo-state';

describe('promo state machine', () => {
  const table: Array<[PromoStatus, PromoStatus, boolean]> = [
    ['draft', 'published', true],
    ['draft', 'archived', true],
    ['draft', 'draft', false],
    ['published', 'archived', true],
    ['published', 'draft', false],
    ['published', 'published', false],
    ['archived', 'published', false],
    ['archived', 'draft', false],
    ['archived', 'archived', false],
  ];

  it.each(table)('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionPromo(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertPromoTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertPromoTransition(from, to)).toThrow(DomainError);
      try {
        assertPromoTransition(from, to);
      } catch (error) {
        expect(error).toMatchObject({ code: 'PC_PROMO_INVALID_TRANSITION', status: 409 });
      }
    }
  });

  it('covers every status and marks only archived as final', () => {
    for (const status of PROMO_STATUSES) {
      expect(typeof isPromoFinal(status)).toBe('boolean');
    }
    expect(PROMO_STATUSES.filter((status) => isPromoFinal(status))).toEqual(['archived']);
  });
});
