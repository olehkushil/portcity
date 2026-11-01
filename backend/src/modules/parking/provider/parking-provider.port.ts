import type { ParkingZone } from '../../../common/contracts/parking';

/**
 * What the parking operator's system knows about one stay. Facts only: the status is derived
 * locally from (enteredAt, paidUntil, exitedAt, now) by `domain/session-state.ts`.
 */
export interface ProviderSessionSnapshot {
  /** Session id at the operator; `ParkingSession.providerRef` (unique). */
  providerRef: string;
  /** Normalised plate (Latin, no spaces) or null when the car entered with a talon only. */
  plate: string | null;
  zone: ParkingZone;
  enteredAt: Date;
  exitedAt: Date | null;
  /** End of the paid period registered at the operator (app payment or paymat). */
  paidUntil: Date | null;
  amountPaidKopecks: number;
  /** Amount the operator's system reports as due; informational, the local tariff is authoritative. */
  amountDueKopecks: number | null;
  /** Operator close reason, e.g. `exit`, `air_raid`, `privilege`. */
  closedReason: string | null;
  /** Parking level when the operator knows it (camera or spot sensor), e.g. `-2`. */
  level?: string | null;
  /** Row or spot label when known, e.g. `C`. */
  spot?: string | null;
}

export interface ProviderPaymentRegistration {
  providerRef: string;
  paymentId: string;
  amountKopecks: number;
  paidUntil: Date;
}

export type ProviderVerificationResult = 'verified' | 'invalid_code' | 'unknown_plate';

export interface ProviderVerificationRequest {
  plate: string;
  talonCode?: string;
  paymatCode?: string;
}

export interface ProviderWebhookRequest {
  /** Parsed JSON body as Express delivered it. */
  body: unknown;
  /**
   * Exact bytes received (`rawBody: true` in NestFactory.create, read from `request.rawBody`);
   * signatures are computed over them. Absent only for in-process calls.
   */
  rawBody?: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ProviderWebhookEvent {
  eventId: string;
  type: string;
  snapshot: ProviderSessionSnapshot;
}

/**
 * Port to the parking operator's system (brief section 2: "provider port + emulator").
 * The abstract class doubles as the Nest injection token. Implementations: EmulatorParkingProvider
 * (dev, CI), VendorParkingProvider (stub until the operator's API is known), FakeParkingProvider
 * (tests). Every method may throw PC_PARKING_PROVIDER_UNAVAILABLE.
 */
export abstract class ParkingProviderPort {
  abstract readonly name: string;
  /** Sessions whose car is still inside. */
  abstract listActiveSessions(): Promise<ProviderSessionSnapshot[]>;
  /** The active session of a plate, or null. */
  abstract findSessionByPlate(plate: string): Promise<ProviderSessionSnapshot | null>;
  /** A session by operator id (also closed ones), or null when unknown. */
  abstract getSessionByRef(providerRef: string): Promise<ProviderSessionSnapshot | null>;
  /**
   * The session of an entry talon (the paper ticket taken at the barrier), or null when the
   * operator knows no session for it. Cars entering without a recognised plate have only this.
   */
  abstract findSessionByTalon(talonCode: string): Promise<ProviderSessionSnapshot | null>;
  /** Tells the operator a payment succeeded so the barrier opens until `paidUntil`. Idempotent by paymentId. */
  abstract registerPayment(input: ProviderPaymentRegistration): Promise<void>;
  /** Checks a talon or paymat code against the plate. */
  abstract verifyVehicle(input: ProviderVerificationRequest): Promise<ProviderVerificationResult>;
  /** Verifies the signature and parses a callback; throws PC_PARKING_WEBHOOK_* on failure. */
  abstract parseWebhook(request: ProviderWebhookRequest): ProviderWebhookEvent;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
