import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqual } from '../../../common/auth/crypto';
import type { ParkingEmulatorScenario } from '../../../common/config';
import { PARKING_ZONES, type ParkingZone } from '../../../common/contracts/parking';
import { DomainError } from '../../../common/errors/domain-error';
import { canonicalJson } from '../../../common/idempotency/request-hash';
import type { Clock } from '../../../common/time/clock';
import { kyivTimeAt } from '../../../common/time/kyiv';
import { ParkingErrors } from '../domain/errors';
import { normalisePlate } from '../domain/plate';
import { CLOSE_REASONS } from '../domain/session-state';
import { codeMatchesPlate } from '../domain/verification';
import {
  ParkingProviderPort,
  type ProviderPaymentRegistration,
  type ProviderSessionSnapshot,
  type ProviderVerificationRequest,
  type ProviderVerificationResult,
  type ProviderWebhookEvent,
  type ProviderWebhookRequest,
  headerValue,
} from './parking-provider.port';

export const EMULATOR_PROVIDER_NAME = 'emulator';
export const EMULATOR_DEMO_REF = 'emu-demo-session';
/** Talon-only demo session: a car whose plate the camera did not read (plate null). */
export const EMULATOR_TALON_REF = 'emu-talon-session';
export const PARKING_WEBHOOK_SIGNATURE_HEADER = 'x-parking-signature';

/**
 * Prototype timeline, Kyiv wall clock (canon: design/v2/CONVENTIONS.md and the design brief,
 * section 4): entry 14:00 on the underground level -2 row C, free until 14:30, 20 UAH for
 * 14:30-15:00, 40 UAH for 15:00-16:00, so 60 UAH are due at 15:20; a payment at 15:20 buys the
 * exit until 16:00; the closed variant leaves at 15:52 ("1 h 52 min, 60 UAH").
 * BRIEF section 11 still says 14:12; the canon wins because only 14:00 makes "60 UAH at 15:20,
 * paid until 16:00" consistent with the tariff.
 */
export const EMULATOR_TIMELINE = {
  enteredAt: '14:00',
  paidAt: '15:20',
  paidUntil: '16:00',
  exitedAt: '15:52',
  paidAmountKopecks: 6000,
  level: '-2',
  spot: 'C',
  /** Entry talon of the talon-only demo session (POST /parking/sessions/claim). */
  talonCode: 'PC-0418227',
} as const;

/** Talon codes compare without case, spaces and dashes (`pc 0418227` = `PC-0418227`). */
export function normaliseTalon(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * With `anchor: 'now'` the timeline is shifted once, when the emulator is created, so that the
 * current moment is the scenario's canonical moment (useful for demos outside 14:00-16:00);
 * afterwards it runs in real time.
 */
export const EMULATOR_SCENARIO_MOMENTS: Readonly<Record<ParkingEmulatorScenario, string>> =
  Object.freeze({
    free: '14:11',
    payable: '15:20',
    paid: '15:25',
    closed: '15:55',
  });

export type EmulatorAnchor = 'today' | 'now';

export interface EmulatorOptions {
  scenario: ParkingEmulatorScenario;
  plate: string;
  zone?: ParkingZone;
  webhookSecret: string;
  /** `today` (default): facts appear at the wall-clock times of the current Kyiv day, like the seed. */
  anchor?: EmulatorAnchor;
  /** Talon of the talon-only demo session (default EMULATOR_TIMELINE.talonCode). */
  talonCode?: string;
}

interface RegisteredPayment {
  paidUntil: Date;
  amountKopecks: number;
  paymentIds: Set<string>;
}

const isoDate = z.iso.datetime({ offset: true });

const webhookSchema = z.object({
  eventId: z.string().min(1).max(100),
  type: z.string().min(1).max(50).default('session.updated'),
  session: z.object({
    providerRef: z.string().min(1).max(100),
    plate: z.string().min(2).max(20).nullable().optional(),
    zone: z.enum(PARKING_ZONES).default('underground'),
    enteredAt: isoDate,
    exitedAt: isoDate.nullable().optional(),
    paidUntil: isoDate.nullable().optional(),
    amountPaidKopecks: z.number().int().min(0).default(0),
    amountDueKopecks: z.number().int().min(0).nullable().optional(),
    closedReason: z.string().max(100).nullable().optional(),
    level: z.string().max(20).nullable().optional(),
    spot: z.string().max(20).nullable().optional(),
  }),
});

/**
 * Signs a webhook body the way the emulator expects it (dev tooling and tests):
 * `sha256=<HMAC-SHA256 hex>` over the exact body bytes when given a string or Buffer (what goes
 * on the wire); a parsed object is signed over its canonical JSON (the fallback the adapter uses
 * when no raw body is available, i.e. in-process calls).
 */
export function signParkingWebhook(secret: string, body: unknown): string {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : canonicalJson(body);
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/**
 * Parking operator emulator (PARKING_PROVIDER=emulator). It replays the prototype storyline for
 * the demo plate (EMULATOR_TIMELINE): entry at 14:00, free until 14:30, 60 UAH due at 15:20;
 * scenario `paid` adds a payment at 15:20 valid until 16:00 (so it turns into an overstay after
 * 16:00), scenario `closed` adds the exit at 15:52. Facts appear at their wall-clock times of the
 * current Kyiv day (or of the shifted day with `anchor: 'now'`), so the demo evolves in real time.
 * Payments registered through `registerPayment` extend the paid period in memory.
 */
export class EmulatorParkingProvider extends ParkingProviderPort {
  readonly name = EMULATOR_PROVIDER_NAME;
  private readonly payments = new Map<string, RegisteredPayment>();
  private readonly zone: ParkingZone;
  /** Milliseconds the virtual timeline lags behind real time (0 for `anchor: 'today'`). */
  private readonly shiftMs: number;

  constructor(
    private readonly options: EmulatorOptions,
    private readonly clock: Clock,
  ) {
    super();
    this.zone = options.zone ?? 'underground';
    if (options.anchor === 'now') {
      const now = clock.now();
      const moment = kyivTimeAt(now, EMULATOR_SCENARIO_MOMENTS[options.scenario]);
      this.shiftMs = now.getTime() - moment.getTime();
    } else {
      this.shiftMs = 0;
    }
  }

  /** The demo session as the operator would report it at `now`, or null before the entry time. */
  demoSnapshot(now: Date = this.clock.now()): ProviderSessionSnapshot | null {
    return this.timelineSnapshot(EMULATOR_DEMO_REF, this.options.plate, now);
  }

  /** The talon-only demo session (same timeline, no plate), or null before the entry time. */
  talonSnapshot(now: Date = this.clock.now()): ProviderSessionSnapshot | null {
    return this.timelineSnapshot(EMULATOR_TALON_REF, null, now);
  }

  private timelineSnapshot(
    providerRef: string,
    plate: string | null,
    now: Date,
  ): ProviderSessionSnapshot | null {
    const virtualNow = new Date(now.getTime() - this.shiftMs);
    const at = (hhmm: string): Date => kyivTimeAt(virtualNow, hhmm);
    const real = (virtual: Date): Date => new Date(virtual.getTime() + this.shiftMs);
    const enteredAt = at(EMULATOR_TIMELINE.enteredAt);
    if (virtualNow.getTime() < enteredAt.getTime()) {
      return null;
    }
    const snapshot: ProviderSessionSnapshot = {
      providerRef,
      plate,
      zone: this.zone,
      enteredAt: real(enteredAt),
      exitedAt: null,
      paidUntil: null,
      amountPaidKopecks: 0,
      amountDueKopecks: null,
      closedReason: null,
      level: this.zone === 'underground' ? EMULATOR_TIMELINE.level : null,
      spot: EMULATOR_TIMELINE.spot,
    };
    const { scenario } = this.options;
    if (scenario === 'paid' || scenario === 'closed') {
      const paidAt = at(EMULATOR_TIMELINE.paidAt);
      if (virtualNow.getTime() >= paidAt.getTime()) {
        snapshot.paidUntil = real(at(EMULATOR_TIMELINE.paidUntil));
        snapshot.amountPaidKopecks = EMULATOR_TIMELINE.paidAmountKopecks;
      }
    }
    if (scenario === 'closed') {
      const exitedAt = at(EMULATOR_TIMELINE.exitedAt);
      if (virtualNow.getTime() >= exitedAt.getTime()) {
        snapshot.exitedAt = real(exitedAt);
        snapshot.closedReason = CLOSE_REASONS.exit;
      }
    }
    return this.withRegisteredPayments(snapshot);
  }

  async listActiveSessions(): Promise<ProviderSessionSnapshot[]> {
    return [this.demoSnapshot(), this.talonSnapshot()].filter(
      (snapshot): snapshot is ProviderSessionSnapshot =>
        snapshot !== null && snapshot.exitedAt === null,
    );
  }

  async findSessionByPlate(plate: string): Promise<ProviderSessionSnapshot | null> {
    const snapshot = this.demoSnapshot();
    return snapshot && snapshot.plate === plate && snapshot.exitedAt === null ? snapshot : null;
  }

  async getSessionByRef(providerRef: string): Promise<ProviderSessionSnapshot | null> {
    if (providerRef === EMULATOR_DEMO_REF) {
      return this.demoSnapshot();
    }
    if (providerRef === EMULATOR_TALON_REF) {
      return this.talonSnapshot();
    }
    return null;
  }

  async findSessionByTalon(talonCode: string): Promise<ProviderSessionSnapshot | null> {
    const expected = normaliseTalon(this.options.talonCode ?? EMULATOR_TIMELINE.talonCode);
    if (normaliseTalon(talonCode) !== expected) {
      return null;
    }
    const snapshot = this.talonSnapshot();
    return snapshot && snapshot.exitedAt === null ? snapshot : null;
  }

  async registerPayment(input: ProviderPaymentRegistration): Promise<void> {
    const existing = this.payments.get(input.providerRef);
    if (existing) {
      if (existing.paymentIds.has(input.paymentId)) {
        return;
      }
      existing.paymentIds.add(input.paymentId);
      existing.amountKopecks += input.amountKopecks;
      if (input.paidUntil.getTime() > existing.paidUntil.getTime()) {
        existing.paidUntil = input.paidUntil;
      }
      return;
    }
    this.payments.set(input.providerRef, {
      paidUntil: input.paidUntil,
      amountKopecks: input.amountKopecks,
      paymentIds: new Set([input.paymentId]),
    });
  }

  async verifyVehicle(input: ProviderVerificationRequest): Promise<ProviderVerificationResult> {
    if (!/\d/.test(input.plate)) {
      return 'unknown_plate';
    }
    const code = input.talonCode ?? input.paymatCode;
    if (!code) {
      return 'invalid_code';
    }
    return codeMatchesPlate(code, input.plate) ? 'verified' : 'invalid_code';
  }

  parseWebhook(request: ProviderWebhookRequest): ProviderWebhookEvent {
    const signature = headerValue(request.headers[PARKING_WEBHOOK_SIGNATURE_HEADER]);
    // Raw bytes when the HTTP layer kept them (always in the API), canonical JSON otherwise.
    const expected = signParkingWebhook(
      this.options.webhookSecret,
      request.rawBody ?? request.body,
    );
    if (!signature || !safeEqual(signature.trim(), expected)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_WEBHOOK_SIGNATURE,
        `Missing or invalid ${PARKING_WEBHOOK_SIGNATURE_HEADER} header`,
      );
    }
    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_WEBHOOK_MALFORMED,
        'Parking webhook payload does not match the emulator format',
        {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        },
      );
    }
    const { session } = parsed.data;
    const plate = session.plate ? (normalisePlate(session.plate)?.plate ?? null) : null;
    return {
      eventId: parsed.data.eventId,
      type: parsed.data.type,
      snapshot: {
        providerRef: session.providerRef,
        plate,
        zone: session.zone,
        enteredAt: new Date(session.enteredAt),
        exitedAt: session.exitedAt ? new Date(session.exitedAt) : null,
        paidUntil: session.paidUntil ? new Date(session.paidUntil) : null,
        amountPaidKopecks: session.amountPaidKopecks,
        amountDueKopecks: session.amountDueKopecks ?? null,
        closedReason: session.closedReason ?? null,
        level: session.level ?? null,
        spot: session.spot ?? null,
      },
    };
  }

  /** Registered payments per provider ref (for tests and diagnostics). */
  registeredPayments(providerRef: string): { paidUntil: Date; amountKopecks: number } | null {
    const entry = this.payments.get(providerRef);
    return entry ? { paidUntil: entry.paidUntil, amountKopecks: entry.amountKopecks } : null;
  }

  private withRegisteredPayments(snapshot: ProviderSessionSnapshot): ProviderSessionSnapshot {
    const registered = this.payments.get(snapshot.providerRef);
    if (!registered) {
      return snapshot;
    }
    const paidUntil =
      snapshot.paidUntil && snapshot.paidUntil.getTime() > registered.paidUntil.getTime()
        ? snapshot.paidUntil
        : registered.paidUntil;
    return {
      ...snapshot,
      paidUntil,
      amountPaidKopecks: snapshot.amountPaidKopecks + registered.amountKopecks,
    };
  }
}
