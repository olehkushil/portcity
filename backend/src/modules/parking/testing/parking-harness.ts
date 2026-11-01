import type { Vehicle } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../../common/audit/audit.service';
import type { ParkingEmulatorScenario } from '../../../common/config';
import { FeatureFlagsService } from '../../../common/feature-flags/feature-flags.service';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { FakeClock } from '../../../common/time/clock';
import { normalisePlate } from '../domain/plate';
import { type ParkingConfig, defaultParkingConfig } from '../parking.config';
import { EmulatorParkingProvider } from '../provider/emulator.provider';
import type { ParkingProviderPort } from '../provider/parking-provider.port';
import { AirRaidService } from '../services/air-raid.service';
import { InfoModeService } from '../services/info-mode.service';
import { InMemoryLookupLimiter } from '../services/lookup-limiter';
import { ParkingErasureService } from '../services/parking-erasure.service';
import { ParkingPaymentsService } from '../services/parking-payments.service';
import { ParkingService } from '../services/parking.service';
import { SessionSyncService } from '../services/session-sync.service';
import { SessionsService } from '../services/sessions.service';
import { TariffService } from '../services/tariff.service';
import { VehiclesService } from '../services/vehicles.service';
import { FakePaymentsPort } from './fake-payments-port';
import { FakeParkingProvider } from './fake-parking-provider';
import { FakePrisma } from './fake-prisma';

export const TEST_SECRET = 'test-parking-webhook-secret';
export const USER_ID = '0192f3a0-0000-7000-8000-000000000001';
export const OTHER_USER_ID = '0192f3a0-0000-7000-8000-000000000002';

export interface HarnessOptions {
  /** ISO instant of the fake clock (default 2026-01-15T12:00:00Z = 14:00 Kyiv). */
  now?: string;
  /** `fake` (default): scriptable FakeParkingProvider; `emulator`: the in-process emulator. */
  provider?: 'fake' | 'emulator';
  scenario?: ParkingEmulatorScenario;
  config?: Partial<ParkingConfig>;
}

/**
 * Wires every parking service by hand on in-memory fakes (no Nest, no database): FakePrisma,
 * FakeClock, the real OutboxService / FeatureFlagsService / AuditService on the fake client,
 * FakePaymentsPort and a scriptable or emulated operator.
 */
export class ParkingHarness {
  readonly clock: FakeClock;
  readonly prisma: FakePrisma;
  readonly config: ParkingConfig;
  readonly provider: ParkingProviderPort;
  readonly outbox: OutboxService;
  readonly flags: FeatureFlagsService;
  readonly audit: AuditService;
  readonly paymentsPort: FakePaymentsPort;
  readonly tariffs: TariffService;
  readonly airRaid: AirRaidService;
  readonly limiter: InMemoryLookupLimiter;
  readonly sync: SessionSyncService;
  readonly vehicles: VehiclesService;
  readonly sessions: SessionsService;
  readonly info: InfoModeService;
  readonly payments: ParkingPaymentsService;
  readonly parking: ParkingService;
  readonly erasure: ParkingErasureService;

  constructor(options: HarnessOptions = {}) {
    this.clock = new FakeClock(options.now ?? '2026-01-15T12:00:00.000Z');
    this.prisma = new FakePrisma(() => this.clock.now());
    this.config = defaultParkingConfig({ PARKING_WEBHOOK_SECRET: TEST_SECRET, ...options.config });
    this.provider =
      options.provider === 'emulator'
        ? new EmulatorParkingProvider(
            {
              scenario: options.scenario ?? 'payable',
              plate: this.config.PARKING_EMULATOR_PLATE,
              webhookSecret: TEST_SECRET,
              anchor: this.config.PARKING_EMULATOR_ANCHOR,
            },
            this.clock,
          )
        : new FakeParkingProvider();
    const prisma = this.prisma.asPrisma();
    this.outbox = new OutboxService(prisma, this.clock);
    this.flags = new FeatureFlagsService(prisma, this.clock);
    this.audit = new AuditService(prisma, this.clock);
    this.paymentsPort = new FakePaymentsPort(() => this.clock.now());
    this.tariffs = new TariffService(prisma, this.clock, this.audit);
    this.airRaid = new AirRaidService(this.flags, this.config);
    this.limiter = new InMemoryLookupLimiter(this.clock);
    this.sync = new SessionSyncService(
      prisma,
      this.clock,
      this.outbox,
      this.provider,
      this.tariffs,
      this.airRaid,
      this.config,
    );
    this.vehicles = new VehiclesService(
      prisma,
      this.clock,
      this.outbox,
      this.provider,
      this.limiter,
      this.config,
    );
    this.sessions = new SessionsService(
      prisma,
      this.clock,
      this.sync,
      this.tariffs,
      this.vehicles,
      this.airRaid,
      this.limiter,
      this.outbox,
      this.flags,
      this.paymentsPort,
      this.config,
    );
    this.info = new InfoModeService(
      prisma,
      this.clock,
      this.sync,
      this.sessions,
      this.tariffs,
      this.config,
    );
    this.payments = new ParkingPaymentsService(
      prisma,
      this.clock,
      this.sync,
      this.tariffs,
      this.provider,
      this.outbox,
      this.paymentsPort,
      this.audit,
      this.config,
    );
    this.parking = new ParkingService(prisma, this.clock, this.tariffs, this.sync, this.audit);
    this.erasure = new ParkingErasureService(prisma, this.clock);
  }

  get fakeProvider(): FakeParkingProvider {
    if (!(this.provider instanceof FakeParkingProvider)) {
      throw new Error('The harness runs the emulator, not the fake provider');
    }
    return this.provider;
  }

  get emulator(): EmulatorParkingProvider {
    if (!(this.provider instanceof EmulatorParkingProvider)) {
      throw new Error('The harness runs the fake provider, not the emulator');
    }
    return this.provider;
  }

  /** Kyiv wall clock of 2026-01-15 (UTC+2): `at('15:20')`. */
  static at(hhmm: string, day = '2026-01-15'): Date {
    return new Date(`${day}T${hhmm}:00.000+02:00`);
  }

  setTime(hhmm: string, day = '2026-01-15'): void {
    this.clock.set(ParkingHarness.at(hhmm, day));
  }

  async addVehicle(
    userId: string,
    plate: string,
    options: { verified?: boolean; isDefault?: boolean } = {},
  ): Promise<Vehicle> {
    const normalised = normalisePlate(plate);
    if (!normalised) {
      throw new Error(`Bad test plate ${plate}`);
    }
    const verified = options.verified ?? true;
    const row = await this.prisma.vehicle.create({
      data: {
        id: uuidv7(),
        userId,
        plate: normalised.plate,
        plateDisplay: normalised.plateDisplay,
        verified,
        verifiedVia: verified ? 'talon' : 'none',
        verifiedAt: verified ? this.clock.now() : null,
        isDefault: options.isDefault ?? true,
        createdAt: this.clock.now(),
        deletedAt: null,
      },
    });
    return row as unknown as Vehicle;
  }

  async setFlag(key: string, enabled: boolean, payload: Record<string, unknown> | null = null) {
    await this.prisma.featureFlag.upsert({
      where: { key },
      create: { key, enabled, payload, updatedAt: this.clock.now() },
      update: { enabled, payload, updatedAt: this.clock.now() },
    });
    this.flags.invalidate();
  }

  /** Outbox event types in insertion order. */
  events(): string[] {
    return this.prisma.outboxTypes();
  }

  eventPayloads(type: string): Record<string, unknown>[] {
    return this.prisma.outboxEvent.rows
      .filter((row) => row['type'] === type)
      .map((row) => row['payload'] as Record<string, unknown>);
  }

  sessionsRows(): Record<string, unknown>[] {
    return this.prisma.parkingSession.rows;
  }
}
