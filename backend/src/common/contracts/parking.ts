/**
 * Parking contract: current session lookup and tariff quotes.
 * Implemented by `src/modules/parking`, provided under PARKING_PORT.
 * Consumers: rewards (parking_hour fulfilment), notifications (message texts), admin (reports).
 * Parking itself depends on PAYMENTS_PORT (pay a session) and reacts to `payment.succeeded`.
 */
import type { DateRange, Kopecks, Uuid } from './shared';

export const PARKING_PORT = Symbol('PARKING_PORT');

export const PARKING_ZONES = ['underground', 'surface'] as const;
export type ParkingZone = (typeof PARKING_ZONES)[number];

export const PARKING_SESSION_STATUSES = [
  'open',
  'payable',
  'paid',
  'overstay',
  'closed',
  'closed_unpaid',
  'closed_free',
] as const;
export type ParkingSessionStatus = (typeof PARKING_SESSION_STATUSES)[number];

export const PARKING_SESSION_SOURCES = ['provider', 'info_timer'] as const;
export type ParkingSessionSource = (typeof PARKING_SESSION_SOURCES)[number];

export const VEHICLE_VERIFIED_VIA = ['talon', 'paymat_code', 'operator', 'none'] as const;
export type VehicleVerifiedVia = (typeof VEHICLE_VERIFIED_VIA)[number];

/** Normalised plate: Latin letters and digits only, no spaces (AC1234BC). */
export const PLATE_PATTERN = /^[A-Z0-9]{3,12}$/;

/** Shape of ParkingTariff.config (brief section 4). */
export interface ParkingTariffConfig {
  freeMinutes: number;
  /** Minutes 31-60. */
  firstHourKopecks: Kopecks;
  /** Every further started hour. */
  nextHourKopecks: Kopecks;
  /** Started hours whose start falls inside the window (Kyiv wall clock) cost hourKopecks. */
  nightWindow: { from: string; to: string; hourKopecks: Kopecks };
  lostTicketKopecks: Kopecks;
  exitGraceMinutes: number;
  /** `HH:mm-HH:mm` opening hours per zone (informational). */
  undergroundHours: string;
  surfaceHours: string;
}

export const DEFAULT_PARKING_TARIFF: ParkingTariffConfig = Object.freeze({
  freeMinutes: 30,
  firstHourKopecks: 2000,
  nextHourKopecks: 4000,
  nightWindow: Object.freeze({ from: '00:00', to: '05:00', hourKopecks: 50_000 }),
  lostTicketKopecks: 50_000,
  exitGraceMinutes: 0,
  undergroundHours: '08:00-21:00',
  surfaceHours: '05:00-24:00',
});

export type ParkingChargeKind = 'free' | 'first_hour' | 'hour' | 'night';

export interface ParkingChargeLine {
  from: Date;
  to: Date;
  kind: ParkingChargeKind;
  amountKopecks: Kopecks;
}

/** Result of `quote(enteredAt, now, tariff, paidUntil?)` (brief section 7). */
export interface ParkingQuote {
  amountDueKopecks: Kopecks;
  freeUntil: Date;
  /** End of the hour that is currently running (what a payment made now buys). */
  currentHourEndsAt: Date;
  breakdown: ParkingChargeLine[];
}

export interface QuoteInput {
  enteredAt: Date;
  /** Defaults to the clock's now. */
  now?: Date;
  /** End of the already paid period, if any. */
  paidUntil?: Date | null;
  zone?: ParkingZone;
}

export interface ParkingSessionSummary {
  id: Uuid;
  userId: Uuid | null;
  vehicleId: Uuid | null;
  plate: string | null;
  zone: ParkingZone;
  enteredAt: Date;
  exitedAt: Date | null;
  status: ParkingSessionStatus;
  paidUntil: Date | null;
  amountDueKopecks: Kopecks;
  amountPaidKopecks: Kopecks;
  source: ParkingSessionSource;
  lastSyncedAt: Date | null;
}

export interface ParkingDailyStats {
  opened: number;
  closed: number;
  paidKopecks: Kopecks;
}

export interface ParkingPort {
  /** The user's non-final session (open, payable, paid or overstay) across their vehicles, or null. */
  getSessionForUser(userId: Uuid): Promise<ParkingSessionSummary | null>;
  getSession(sessionId: Uuid): Promise<ParkingSessionSummary | null>;
  /** Tariff calculation with the tariff active at `now`. */
  quote(input: QuoteInput): Promise<ParkingQuote>;
  getActiveTariff(at?: Date): Promise<{ version: number; config: ParkingTariffConfig }>;
  getDailyStats(range: DateRange): Promise<ParkingDailyStats>;
}

export const PARKING_ERROR_CODES = [
  'PC_PARKING_UNKNOWN_PLATE',
  'PC_PARKING_PLATE_INVALID',
  'PC_PARKING_VEHICLE_NOT_FOUND',
  'PC_PARKING_VEHICLE_EXISTS',
  'PC_PARKING_VEHICLE_NOT_VERIFIED',
  'PC_PARKING_VERIFICATION_FAILED',
  'PC_PARKING_SESSION_NOT_FOUND',
  'PC_PARKING_NOTHING_DUE',
  'PC_PARKING_INVALID_TRANSITION',
  'PC_PARKING_PROVIDER_UNAVAILABLE',
  'PC_PARKING_TARIFF_NOT_FOUND',
  'PC_PARKING_INFO_MODE_DISABLED',
  /** 422: more than PARKING_MAX_VEHICLES vehicles. */
  'PC_PARKING_VEHICLE_LIMIT',
  /** 429: lookup quota for unverified plates (10 per hour) is used up. */
  'PC_PARKING_LOOKUP_LIMIT',
  /** 409: a second info-mode timer while one is running. */
  'PC_PARKING_SESSION_ACTIVE_EXISTS',
  /** 401: operator webhook signature is wrong. */
  'PC_PARKING_WEBHOOK_SIGNATURE',
  /** 400: operator webhook body is malformed. */
  'PC_PARKING_WEBHOOK_MALFORMED',
  /** 404: the operator knows no active session for this talon. */
  'PC_PARKING_TALON_UNKNOWN',
  /** 409: the session is already attached to another account. */
  'PC_PARKING_SESSION_CLAIMED',
  /** 429: talon claims per member per hour are used up. */
  'PC_PARKING_CLAIM_LIMIT',
  /** 429: verification attempts for this vehicle in 24 h are used up. */
  'PC_PARKING_VERIFICATION_LIMIT',
] as const;

/** Reasons a member gives for «Це не моє авто» (F2) and other session disputes. */
export const PARKING_DISPUTE_REASONS = ['not_my_car', 'wrong_amount', 'barrier'] as const;
export type ParkingDisputeReason = (typeof PARKING_DISPUTE_REASONS)[number];
export type ParkingErrorCode = (typeof PARKING_ERROR_CODES)[number];
