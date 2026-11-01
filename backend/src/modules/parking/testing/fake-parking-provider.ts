import { DomainError } from '../../../common/errors/domain-error';
import { ParkingErrors } from '../domain/errors';
import {
  ParkingProviderPort,
  type ProviderPaymentRegistration,
  type ProviderSessionSnapshot,
  type ProviderVerificationRequest,
  type ProviderVerificationResult,
  type ProviderWebhookEvent,
  type ProviderWebhookRequest,
  headerValue,
} from '../provider/parking-provider.port';

export const FAKE_WEBHOOK_SIGNATURE = 'fake-valid-signature';

interface WebhookBody {
  eventId: string;
  type?: string;
  session: {
    providerRef: string;
    plate?: string | null;
    zone?: 'underground' | 'surface';
    enteredAt: string;
    exitedAt?: string | null;
    paidUntil?: string | null;
    amountPaidKopecks?: number;
    amountDueKopecks?: number | null;
    closedReason?: string | null;
  };
}

/**
 * Scriptable provider for unit and e2e tests: sessions are set explicitly, payments and
 * verification calls are recorded, failures can be injected with `failWith`.
 */
export class FakeParkingProvider extends ParkingProviderPort {
  readonly name = 'fake';
  readonly sessions = new Map<string, ProviderSessionSnapshot>();
  /** Talon code (upper case, as given) -> providerRef. */
  readonly talons = new Map<string, string>();
  readonly registeredPayments: ProviderPaymentRegistration[] = [];
  readonly verificationCalls: ProviderVerificationRequest[] = [];
  verification: ProviderVerificationResult = 'verified';
  failWith: Error | null = null;

  set(snapshot: ProviderSessionSnapshot): this {
    this.sessions.set(snapshot.providerRef, { ...snapshot });
    return this;
  }

  remove(providerRef: string): this {
    this.sessions.delete(providerRef);
    return this;
  }

  /** Registers a session reachable by its entry talon. */
  setTalon(talonCode: string, snapshot: ProviderSessionSnapshot): this {
    this.set(snapshot);
    this.talons.set(talonCode.toUpperCase(), snapshot.providerRef);
    return this;
  }

  async findSessionByTalon(talonCode: string): Promise<ProviderSessionSnapshot | null> {
    this.maybeFail();
    const ref = this.talons.get(talonCode.toUpperCase());
    const session = ref ? this.sessions.get(ref) : undefined;
    return session && session.exitedAt === null ? { ...session } : null;
  }

  async listActiveSessions(): Promise<ProviderSessionSnapshot[]> {
    this.maybeFail();
    return [...this.sessions.values()].filter((session) => session.exitedAt === null);
  }

  async findSessionByPlate(plate: string): Promise<ProviderSessionSnapshot | null> {
    this.maybeFail();
    return (
      [...this.sessions.values()].find(
        (session) => session.plate === plate && session.exitedAt === null,
      ) ?? null
    );
  }

  async getSessionByRef(providerRef: string): Promise<ProviderSessionSnapshot | null> {
    this.maybeFail();
    return this.sessions.get(providerRef) ?? null;
  }

  async registerPayment(input: ProviderPaymentRegistration): Promise<void> {
    this.maybeFail();
    if (this.registeredPayments.some((entry) => entry.paymentId === input.paymentId)) {
      return;
    }
    this.registeredPayments.push({ ...input });
    const session = this.sessions.get(input.providerRef);
    if (session) {
      session.paidUntil =
        session.paidUntil && session.paidUntil.getTime() > input.paidUntil.getTime()
          ? session.paidUntil
          : input.paidUntil;
      session.amountPaidKopecks += input.amountKopecks;
    }
  }

  async verifyVehicle(input: ProviderVerificationRequest): Promise<ProviderVerificationResult> {
    this.maybeFail();
    this.verificationCalls.push({ ...input });
    return this.verification;
  }

  parseWebhook(request: ProviderWebhookRequest): ProviderWebhookEvent {
    if (headerValue(request.headers['x-parking-signature']) !== FAKE_WEBHOOK_SIGNATURE) {
      throw new DomainError(ParkingErrors.PC_PARKING_WEBHOOK_SIGNATURE, 'Bad fake signature');
    }
    const body = request.body as Partial<WebhookBody> | null;
    if (!body || typeof body.eventId !== 'string' || !body.session?.providerRef) {
      throw new DomainError(ParkingErrors.PC_PARKING_WEBHOOK_MALFORMED, 'Bad fake payload');
    }
    const session = body.session;
    return {
      eventId: body.eventId,
      type: body.type ?? 'session.updated',
      snapshot: {
        providerRef: session.providerRef,
        plate: session.plate ?? null,
        zone: session.zone ?? 'underground',
        enteredAt: new Date(session.enteredAt),
        exitedAt: session.exitedAt ? new Date(session.exitedAt) : null,
        paidUntil: session.paidUntil ? new Date(session.paidUntil) : null,
        amountPaidKopecks: session.amountPaidKopecks ?? 0,
        amountDueKopecks: session.amountDueKopecks ?? null,
        closedReason: session.closedReason ?? null,
      },
    };
  }

  private maybeFail(): void {
    if (this.failWith) {
      throw this.failWith;
    }
  }
}

/** Builds a snapshot with sensible defaults for tests. */
export function snapshot(
  overrides: Partial<ProviderSessionSnapshot> &
    Pick<ProviderSessionSnapshot, 'providerRef' | 'enteredAt'>,
): ProviderSessionSnapshot {
  return {
    plate: 'AC1234BC',
    zone: 'underground',
    exitedAt: null,
    paidUntil: null,
    amountPaidKopecks: 0,
    amountDueKopecks: null,
    closedReason: null,
    ...overrides,
  };
}
