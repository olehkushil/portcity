import { format } from 'date-fns';
import { uk } from 'date-fns/locale';
import { pluralizeUk } from '../../../common/money/money';
import { toKyiv } from '../../../common/time/kyiv';

/** Shape of the voucher the rewards module issues for a registration or a coupon claim. */
export interface VoucherDraft {
  title: string;
  subtitle: string;
  expiresAt: Date;
  meta: Record<string, unknown>;
}

export interface TicketEventInput {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  venue: string | null;
  ageLimit: number | null;
}

export interface TicketRegistrationInput {
  id: string;
  adults: number;
  children: number;
}

/** "2 дорослих, 1 дитина" (children omitted when zero). */
export function formatPersons(adults: number, children: number): string {
  const parts = [`${adults} ${pluralizeUk(adults, ['дорослий', 'дорослих', 'дорослих'])}`];
  if (children > 0) {
    parts.push(`${children} ${pluralizeUk(children, ['дитина', 'дитини', 'дітей'])}`);
  }
  return parts.join(', ');
}

/** "Сб 1 листопада 12:00" in Kyiv time. */
export function formatEventWhen(startsAt: Date): string {
  const text = format(toKyiv(startsAt), 'EEEEEE d MMMM HH:mm', { locale: uk });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Ticket voucher: title, one-line subtitle for the wallet card, expiry at the end of the event. */
export function buildTicketDraft(
  event: TicketEventInput,
  registration: TicketRegistrationInput,
): VoucherDraft {
  const persons = registration.adults + registration.children;
  const subtitleParts = [formatEventWhen(event.startsAt)];
  if (event.venue) {
    subtitleParts.push(event.venue);
  }
  subtitleParts.push(formatPersons(registration.adults, registration.children));
  return {
    title: event.title,
    subtitle: subtitleParts.join(' · '),
    expiresAt: new Date(event.endsAt.getTime()),
    meta: {
      eventId: event.id,
      registrationId: registration.id,
      adults: registration.adults,
      children: registration.children,
      persons,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      venue: event.venue,
      ageLimit: event.ageLimit,
    },
  };
}

export interface CouponPromoInput {
  id: string;
  title: string;
  tenantId: string | null;
}

export interface CouponTemplateInput {
  id: string;
  discountText: string;
  requiresActivation: boolean;
  validityHoursAfterClaim: number | null;
  terms: string | null;
}

/** Coupon voucher: the discount line is the subtitle; validity travels in `expiresAt` and `meta`. */
export function buildCouponDraft(
  promo: CouponPromoInput,
  template: CouponTemplateInput,
  claim: { claimId: string; expiresAt: Date },
): VoucherDraft {
  return {
    title: promo.title,
    subtitle: template.discountText,
    expiresAt: claim.expiresAt,
    meta: {
      promoId: promo.id,
      couponTemplateId: template.id,
      claimId: claim.claimId,
      discountText: template.discountText,
      terms: template.terms,
      requiresActivation: template.requiresActivation,
      validityHoursAfterClaim: template.validityHoursAfterClaim,
      tenantId: promo.tenantId,
    },
  };
}
