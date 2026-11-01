import type { PromoStatus } from '../../../common/contracts/promos';
import { DomainError } from '../../../common/errors/domain-error';
import { PromosErrors } from './errors';

/**
 * Promo lifecycle (brief section 4): draft -> published -> archived; a draft may be archived
 * directly. Archived is final: a new campaign is a new promo.
 */
export const PROMO_TRANSITIONS: Readonly<Record<PromoStatus, readonly PromoStatus[]>> = {
  draft: ['published', 'archived'],
  published: ['archived'],
  archived: [],
};

export function canTransitionPromo(from: PromoStatus, to: PromoStatus): boolean {
  return PROMO_TRANSITIONS[from].includes(to);
}

export function isPromoFinal(status: PromoStatus): boolean {
  return PROMO_TRANSITIONS[status].length === 0;
}

export function assertPromoTransition(from: PromoStatus, to: PromoStatus): void {
  if (!canTransitionPromo(from, to)) {
    throw new DomainError(
      PromosErrors.PC_PROMO_INVALID_TRANSITION,
      `Promo cannot move from "${from}" to "${to}"`,
      { details: { from, to, allowed: PROMO_TRANSITIONS[from] } },
    );
  }
}
