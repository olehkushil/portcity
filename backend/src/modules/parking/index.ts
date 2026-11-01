export { ParkingModule } from './parking.module';
export { ParkingService } from './services/parking.service';
export type { AdminSessionFilter } from './services/parking.service';
export { TariffService, TARIFF_CACHE_TTL_MS } from './services/tariff.service';
export type { ActiveTariff, CreateTariffInput, TariffRecord } from './services/tariff.service';
export { VehiclesService, toVehicleView } from './services/vehicles.service';
export type { VehicleView, VerifyVehicleInput } from './services/vehicles.service';
export { CLAIMS_PER_HOUR, SessionsService } from './services/sessions.service';
export type {
  HistoryItem,
  HistoryQuery,
  HistorySummary,
  ParkingHero,
  RestrictedSessionView,
} from './services/sessions.service';
export { SessionSyncService } from './services/session-sync.service';
export type {
  ApplyResult,
  ClaimOwner,
  FactsPatch,
  WebhookOutcome,
} from './services/session-sync.service';
export { InfoModeService } from './services/info-mode.service';
export {
  LINK_OUTCOMES,
  PAYMENT_SWEEP_GRACE_MS,
  PAYMENT_SWEEP_WINDOW_HOURS,
  ParkingPaymentsService,
} from './services/parking-payments.service';
export type {
  ParkingPaymentView,
  ParkingPaymentsSweepSummary,
  PaymentApplication,
  UnusableReason,
} from './services/parking-payments.service';
export { DEFAULT_PAY_MIN_MINUTES_LEFT, payCharge } from './domain/pay-charge';
export type { PayCharge } from './domain/pay-charge';
export { PAID_VIA, appPaidKopecks, kyivMonthRange, paidVia } from './domain/history';
export type { PaidVia, SessionPaymentView } from './domain/history';
export {
  LONG_RETRY_COUNTER,
  PAYMENT_SUCCEEDED_RETRY,
  longRetryDelayMs,
  runWithLongRetry,
} from './jobs/long-retry';
export { VERIFY_ATTEMPTS_PER_VEHICLE, VERIFY_WINDOW_MS } from './services/vehicles.service';
export type { AddVehicleOptions } from './services/vehicles.service';
export { AirRaidService } from './services/air-raid.service';
export {
  InMemoryLookupLimiter,
  RedisLookupLimiter,
  UnverifiedLookupLimiter,
  createLookupLimiter,
} from './services/lookup-limiter';
export type { LookupDecision } from './services/lookup-limiter';
export { PARKING_CONFIG, defaultParkingConfig, parkingEnvSchema } from './parking.config';
export type { ParkingConfig } from './parking.config';
export { ParkingProviderPort, headerValue } from './provider/parking-provider.port';
export type {
  ProviderPaymentRegistration,
  ProviderSessionSnapshot,
  ProviderVerificationRequest,
  ProviderVerificationResult,
  ProviderWebhookEvent,
  ProviderWebhookRequest,
} from './provider/parking-provider.port';
export {
  EMULATOR_DEMO_REF,
  EMULATOR_PROVIDER_NAME,
  EMULATOR_SCENARIO_MOMENTS,
  EMULATOR_TALON_REF,
  EMULATOR_TIMELINE,
  EmulatorParkingProvider,
  PARKING_WEBHOOK_SIGNATURE_HEADER,
  normaliseTalon,
  signParkingWebhook,
} from './provider/emulator.provider';
export { VENDOR_PROVIDER_NAME, VendorParkingProvider } from './provider/vendor.provider';
export { createParkingProvider } from './provider/parking-provider.factory';
export { ParkingErrors } from './domain/errors';
export { quote, startedHours, isNightHour } from './domain/tariff';
export {
  parseTariffConfig,
  tariffConfigOrDefault,
  tariffConfigSchema,
} from './domain/tariff-config';
export { describeTariff, hourPriceAt } from './domain/tariff-describe';
export { normalisePlate, formatPlate } from './domain/plate';
export {
  ACTIVE_SESSION_STATUSES,
  CLOSE_REASONS,
  FINAL_SESSION_STATUSES,
  SESSION_TRANSITIONS,
  assertTransition,
  canTransition,
  deriveSessionState,
  isFinalStatus,
} from './domain/session-state';
export { planSession } from './domain/reconcile';
export { HERO_ACTIONS, HERO_STATES, heroActions, heroState } from './domain/hero';
export type { HeroAction, HeroState, ParkingMode } from './domain/hero';
export { parseAirRaidFlag } from './domain/air-raid';
export {
  ERASED_PLATE_PREFIX,
  ParkingErasureService,
  erasedPlate,
} from './services/parking-erasure.service';
export type { ParkingErasureSummary } from './services/parking-erasure.service';
export type { AirRaidAlert } from './domain/air-raid';
export { REMINDER_EVENT_BY_KIND } from './domain/parking-events';
export { REMINDER_KINDS, dueReminders } from './domain/reminders';
export type { ReminderKind } from './domain/reminders';
export { PARKING_NOTICES } from './domain/notices';
export type { ParkingNotice } from './domain/notices';
export { buildSessionView } from './domain/session-view';
export type { SessionRecord, SessionView } from './domain/session-view';
export {
  PARKING_JOBS,
  PARKING_PAYMENTS_SWEEP_EVERY_MS,
  PARKING_PAYMENTS_SWEEP_SCHEDULE_ID,
  PARKING_SYNC_SCHEDULE_ID,
} from './jobs/job-names';
export { runParkingSync } from './jobs/parking-sync.job';
export type { ParkingSyncSummary } from './jobs/parking-sync.job';
export { handleParkingEvent, PARKING_CONSUMED_EVENTS } from './jobs/parking-events.handler';
