/**
 * Promos contract: promos, coupon templates and events as seen by other modules.
 * Implemented by `src/modules/promos`, provided under PROMOS_PORT.
 * Consumers: admin (reports, back-office views), notifications (titles for reminders).
 * Rewards must not depend on this port (promos depends on VOUCHER_ISSUER_PORT); coupon validity
 * travels with the voucher (`expiresAt`, `meta`) at issue time.
 */
import type { Uuid } from './shared';

export const PROMOS_PORT = Symbol('PROMOS_PORT');

export const PROMO_KINDS = ['info', 'coupon'] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];

export const PROMO_STATUSES = ['draft', 'published', 'archived'] as const;
export type PromoStatus = (typeof PROMO_STATUSES)[number];

export const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'finished'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_REGISTRATION_STATUSES = ['active', 'cancelled', 'used'] as const;
export type EventRegistrationStatus = (typeof EVENT_REGISTRATION_STATUSES)[number];

/** Promo list filter chips (prototype: Одяг і взуття, Їжа, Розваги, Діти, Краса). */
export const PROMO_CATEGORIES = [
  'fashion',
  'food',
  'entertainment',
  'kids',
  'beauty',
  'electronics',
  'other',
] as const;
export type PromoCategory = (typeof PROMO_CATEGORIES)[number];

/** Event poster filter chips (prototype: Для дітей, Майстер-класи, Кіно). */
export const EVENT_CATEGORIES = ['kids', 'masterclass', 'cinema', 'concert', 'other'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/** registration: in-app registration with a ticket; external: admission elsewhere (externalUrl). */
export const EVENT_ADMISSIONS = ['registration', 'external'] as const;
export type EventAdmission = (typeof EVENT_ADMISSIONS)[number];

/** Persons per registration when neither the event nor the events.registration flag sets it. */
export const DEFAULT_MAX_PERSONS_PER_REGISTRATION = 4;
/** Upper bound an admin (or the flag payload) may set per registration. */
export const MAX_PERSONS_PER_REGISTRATION_LIMIT = 20;

/**
 * Claim state code shown to guests (GET /promos/:id without a token): not an error the API
 * throws, so it is not part of PROMOS_ERROR_CODES.
 */
export const GUEST_CLAIM_CODE = 'PC_AUTH_REQUIRED';
export type GuestClaimCode = typeof GUEST_CLAIM_CODE;

export interface PromoSummary {
  id: Uuid;
  tenantId: Uuid | null;
  title: string;
  kind: PromoKind;
  category: PromoCategory;
  validFrom: Date;
  validTo: Date;
  status: PromoStatus;
  couponTemplateId: Uuid | null;
  priority: number;
}

export interface CouponTemplateSummary {
  id: Uuid;
  discountText: string;
  perUserLimit: number;
  totalLimit: number | null;
  claimedCount: number;
  requiresActivation: boolean;
  /** Null means the coupon lives until the promo's validTo. */
  validityHoursAfterClaim: number | null;
}

export interface EventSummary {
  id: Uuid;
  title: string;
  category: EventCategory;
  tenantId: Uuid | null;
  startsAt: Date;
  endsAt: Date;
  venue: string | null;
  capacity: number | null;
  registeredCount: number;
  registrationOpen: boolean;
  admission: EventAdmission;
  ageLimit: number | null;
  ageMin: number | null;
  ageMax: number | null;
  status: EventStatus;
}

export interface ClaimCheck {
  promoId: Uuid;
  userId: Uuid;
  /** Defaults to the clock's now. */
  now?: Date;
}

/** Outcome of the claim validation hook used before a coupon voucher is issued. */
export type ClaimValidation =
  | { allowed: true; promo: PromoSummary; template: CouponTemplateSummary }
  | { allowed: false; code: PromosErrorCode; detail: string };

export interface PromosPort {
  getPromo(promoId: Uuid): Promise<PromoSummary | null>;
  getEvent(eventId: Uuid): Promise<EventSummary | null>;
  /** Pure check of promo status, validity window, per-user and total limits; no side effects. */
  validateClaim(check: ClaimCheck): Promise<ClaimValidation>;
}

export const PROMOS_ERROR_CODES = [
  'PC_PROMO_NOT_FOUND',
  'PC_PROMO_NOT_PUBLISHED',
  'PC_PROMO_NOT_COUPON',
  'PC_PROMO_EXPIRED',
  'PC_COUPON_LIMIT_REACHED',
  'PC_COUPON_SOLD_OUT',
  'PC_EVENT_NOT_FOUND',
  'PC_EVENT_REGISTRATION_CLOSED',
  'PC_EVENT_FULL',
  'PC_EVENT_ALREADY_REGISTERED',
  'PC_EVENT_NOT_REGISTERED',
  'PC_EVENT_PERSONS_INVALID',
  // Back-office and cancellation codes registered by the module (integration, 2026-11-01).
  'PC_PROMO_INVALID_TRANSITION',
  'PC_PROMO_DATES_INVALID',
  'PC_PROMO_TENANT_NOT_FOUND',
  'PC_PROMO_TEMPLATE_REQUIRED',
  'PC_PROMO_NOT_DRAFT',
  'PC_COUPON_TEMPLATE_NOT_FOUND',
  'PC_COUPON_TEMPLATE_IN_USE',
  'PC_COUPON_TEMPLATE_LIMITS_INVALID',
  'PC_EVENT_INVALID_TRANSITION',
  'PC_EVENT_DATES_INVALID',
  'PC_EVENT_CAPACITY_INVALID',
  'PC_EVENT_NOT_DRAFT',
  /** 422: a member cancels after 11:00 Kyiv on the event day. */
  'PC_EVENT_CANCEL_DEADLINE_PASSED',
  'PC_EVENT_REGISTRATION_NOT_FOUND',
  'PC_EVENT_REGISTRATION_FINAL',
  /** 404: the host tenant of an event does not exist (back office). */
  'PC_EVENT_TENANT_NOT_FOUND',
  /** 422: ageMin > ageMax (back office). */
  'PC_EVENT_AGE_RANGE_INVALID',
  /** 422: admission = external without externalUrl, or registration settings on such an event. */
  'PC_EVENT_ADMISSION_INVALID',
] as const;
export type PromosErrorCode = (typeof PROMOS_ERROR_CODES)[number];
