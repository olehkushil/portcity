import type { CouponTemplate, Event, EventRegistration, Prisma, Promo } from '@prisma/client';
import type { TenantSummary } from '../../../common/contracts/content';
import type {
  CouponTemplateSummary,
  EventSummary,
  PromoSummary,
} from '../../../common/contracts/promos';
import type { VoucherSummary } from '../../../common/contracts/rewards';
import {
  effectiveMaxPersons,
  eventCancelDeadline,
  eventWindowState,
  isRegistrationOpenAt,
  registrationCancelDeadline,
  seatsLeft,
} from '../domain/event-rules';
import { deriveTicketStatus } from '../domain/event-state';
import { publicImageUrl } from '../domain/image-url';
import { promoWindowState, remainingCoupons } from '../domain/promo-rules';
import type { EventDto, RegistrationDto } from '../dto/event.dto';
import type {
  CouponTemplateDto,
  PromoDto,
  PromoTenantDto,
  PromoVoucherDto,
} from '../dto/promo.dto';

export type PromoWithTemplate = Prisma.PromoGetPayload<{ include: { couponTemplate: true } }>;
export type RegistrationWithEvent = Prisma.EventRegistrationGetPayload<{
  include: { event: true };
}>;

export function nonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** What a response needs besides the row: the clock, the image base URL, flag defaults. */
export interface PresentationContext {
  now: Date;
  /** S3_PUBLIC_BASE_URL; null leaves every imageUrl null. */
  imageBaseUrl: string | null;
  /** `maxPersonsPerRegistration` of the events.registration flag payload. */
  defaultMaxPersons?: number | null;
}

export function toPromoTenantDto(tenant: TenantSummary): PromoTenantDto {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    logoKey: tenant.logoKey,
    floor: tenant.floor,
  };
}

export function toCouponTemplateDto(row: CouponTemplate): CouponTemplateDto {
  return {
    id: row.id,
    discountText: row.discountText,
    perUserLimit: row.perUserLimit,
    totalLimit: row.totalLimit,
    claimedCount: row.claimedCount,
    remaining: remainingCoupons(row),
    requiresActivation: row.requiresActivation,
    validityHoursAfterClaim: row.validityHoursAfterClaim,
    terms: row.terms,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCouponTemplateSummary(row: CouponTemplate): CouponTemplateSummary {
  return {
    id: row.id,
    discountText: row.discountText,
    perUserLimit: row.perUserLimit,
    totalLimit: row.totalLimit,
    claimedCount: row.claimedCount,
    requiresActivation: row.requiresActivation,
    validityHoursAfterClaim: row.validityHoursAfterClaim,
  };
}

export function toPromoDto(
  row: PromoWithTemplate,
  tenant: PromoTenantDto | null,
  view: PresentationContext,
): PromoDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenant,
    title: row.title,
    body: row.body,
    kind: row.kind,
    category: row.category,
    validFrom: row.validFrom,
    validTo: row.validTo,
    imageKey: row.imageKey,
    imageUrl: publicImageUrl(view.imageBaseUrl, row.imageKey),
    status: row.status,
    priority: row.priority,
    window: promoWindowState(row, view.now),
    couponTemplate: row.couponTemplate ? toCouponTemplateDto(row.couponTemplate) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPromoSummary(row: Promo): PromoSummary {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    kind: row.kind,
    category: row.category,
    validFrom: row.validFrom,
    validTo: row.validTo,
    status: row.status,
    couponTemplateId: row.couponTemplateId,
    priority: row.priority,
  };
}

export function toVoucherDto(voucher: VoucherSummary): PromoVoucherDto {
  return {
    id: voucher.id,
    kind: voucher.kind,
    title: voucher.title,
    subtitle: voucher.subtitle,
    tenantId: voucher.tenantId,
    status: voucher.status,
    expiresAt: voucher.expiresAt,
    sourceType: voucher.sourceType,
    sourceId: voucher.sourceId,
    meta: voucher.meta,
    createdAt: voucher.createdAt,
  };
}

export function toEventSummary(row: Event): EventSummary {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    tenantId: row.tenantId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    venue: row.venue,
    capacity: row.capacity,
    registeredCount: row.registeredCount,
    registrationOpen: row.registrationOpen,
    admission: row.admission,
    ageLimit: row.ageLimit,
    ageMin: row.ageMin,
    ageMax: row.ageMax,
    status: row.status,
  };
}

export function toRegistrationDto(
  row: EventRegistration,
  event: Pick<Event, 'startsAt' | 'endsAt'>,
  voucher: VoucherSummary | null,
  now: Date,
): RegistrationDto {
  return {
    id: row.id,
    eventId: row.eventId,
    userId: row.userId,
    adults: row.adults,
    children: row.children,
    persons: row.adults + row.children,
    status: row.status,
    ticketStatus: deriveTicketStatus({
      registrationStatus: row.status,
      voucherStatus: voucher?.status ?? null,
      endsAt: event.endsAt,
      now,
    }),
    voucherId: row.voucherId,
    ticket: voucher ? toVoucherDto(voucher) : null,
    cancelDeadline: registrationCancelDeadline(event.startsAt),
    createdAt: row.createdAt,
    cancelledAt: row.cancelledAt,
  };
}

export function toEventDto(
  row: Event,
  view: PresentationContext,
  registration: RegistrationDto | null,
  tenant: PromoTenantDto | null = null,
): EventDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    venue: row.venue,
    category: row.category,
    tenantId: row.tenantId,
    tenant,
    admission: row.admission,
    externalUrl: row.externalUrl,
    maxPersonsPerRegistration: effectiveMaxPersons(row, view.defaultMaxPersons),
    capacity: row.capacity,
    registeredCount: row.registeredCount,
    seatsLeft: seatsLeft(row),
    registrationOpen: row.registrationOpen,
    canRegister: isRegistrationOpenAt(row, view.now),
    ageLimit: row.ageLimit,
    ageMin: row.ageMin,
    ageMax: row.ageMax,
    imageKey: row.imageKey,
    imageUrl: publicImageUrl(view.imageBaseUrl, row.imageKey),
    cancelDeadline: eventCancelDeadline(row),
    status: row.status,
    window: eventWindowState(row, view.now),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    registration,
  };
}
