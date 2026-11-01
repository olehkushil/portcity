export { PromosModule } from './promos.module';
export { PromosService } from './services/promos.service';
export { EventsService } from './services/events.service';
export { PromosAdminService } from './services/promos-admin.service';
export type { AdminActor } from './services/promos-admin.service';
export { EventsAdminService } from './services/events-admin.service';
export { PromosPortService } from './services/promos-port.service';
export { PromosPresenter } from './services/promos-presenter.service';
export type { RegistrationSettings } from './services/promos-presenter.service';
export { guestClaimState } from './services/promos.service';
export { publicImageUrl } from './domain/image-url';
export { PromosErrors } from './domain/errors';
export type { PromosModuleErrorCode } from './domain/errors';
export {
  MAX_PERSONS_PER_REGISTRATION,
  REGISTRATION_CANCEL_DEADLINE_KYIV,
  canCancelRegistration,
  decideRegistration,
  effectiveMaxPersons,
  eventCancelDeadline,
  isExternalAdmission,
  isValidAgeRange,
  maxPersonsFromFlagPayload,
  registrationCancelDeadline,
  seatsLeft,
} from './domain/event-rules';
export {
  EVENT_TRANSITIONS,
  REGISTRATION_TRANSITIONS,
  TICKET_STATUSES,
  deriveTicketStatus,
} from './domain/event-state';
export type { TicketStatus } from './domain/event-state';
export { couponExpiresAt, decideClaim, remainingCoupons } from './domain/promo-rules';
export { PROMO_TRANSITIONS } from './domain/promo-state';
export { buildCouponDraft, buildTicketDraft } from './domain/ticket';
export { PROMOS_JOBS, handlePromosEventsJob } from './jobs/promos-events.handlers';
export type { PromosEventsDeps, PromosJobOutcome } from './jobs/promos-events.handlers';
export {
  PROMOS_PORT,
  type ClaimCheck,
  type ClaimValidation,
  type CouponTemplateSummary,
  type EventSummary,
  type PromoSummary,
  type PromosPort,
} from '../../common/contracts/promos';
