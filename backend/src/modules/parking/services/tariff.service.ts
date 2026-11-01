import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import {
  DEFAULT_PARKING_TARIFF,
  type ParkingQuote,
  type ParkingTariffConfig,
  type QuoteInput,
} from '../../../common/contracts/parking';
import { DomainError } from '../../../common/errors/domain-error';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ParkingErrors } from '../domain/errors';
import { quote } from '../domain/tariff';
import { parseTariffConfig, tariffConfigOrDefault } from '../domain/tariff-config';

/** How long the (tiny) tariff table is served from memory. */
export const TARIFF_CACHE_TTL_MS = 30_000;

export interface TariffRecord {
  id: string;
  version: number;
  activeFrom: Date;
  config: ParkingTariffConfig;
  createdById: string | null;
  createdAt: Date;
}

export interface ActiveTariff {
  version: number;
  config: ParkingTariffConfig;
}

export interface CreateTariffInput {
  activeFrom: Date;
  config: ParkingTariffConfig;
}

export interface AdminActor {
  id: string;
  ip?: string | null;
}

/** Versioned tariffs (`parking_tariffs`): active lookup, quotes and the admin CRUD. */
@Injectable()
export class TariffService {
  private readonly logger = new Logger(TariffService.name);
  private cache: { loadedAt: number; tariffs: TariffRecord[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  /** The tariff active at `at`; the built-in default (version 0) when the table is empty. */
  async getActiveTariff(at: Date = this.clock.now()): Promise<ActiveTariff> {
    const tariffs = await this.loadAll();
    const active = tariffs.find((tariff) => tariff.activeFrom.getTime() <= at.getTime());
    if (!active) {
      return { version: 0, config: { ...DEFAULT_PARKING_TARIFF } };
    }
    return { version: active.version, config: active.config };
  }

  async quote(input: QuoteInput): Promise<ParkingQuote> {
    const now = input.now ?? this.clock.now();
    const { config } = await this.getActiveTariff(now);
    return quote(input.enteredAt, now, config, input.paidUntil ?? null);
  }

  async list(): Promise<TariffRecord[]> {
    return this.loadAll();
  }

  async getByVersion(version: number): Promise<TariffRecord> {
    const tariff = (await this.loadAll()).find((item) => item.version === version);
    if (!tariff) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_TARIFF_NOT_FOUND,
        `Parking tariff version ${version} does not exist`,
      );
    }
    return tariff;
  }

  /** Creates the next version (versions are never edited; a new one supersedes from `activeFrom`). */
  async create(input: CreateTariffInput, actor: AdminActor): Promise<TariffRecord> {
    const parsed = parseTariffConfig(input.config);
    if (!parsed.ok) {
      throw new DomainError(ParkingErrors.PC_PARKING_TARIFF_NOT_FOUND, 'Tariff config is invalid', {
        status: 400,
        title: 'Tariff config is invalid',
        details: parsed.issues,
      });
    }
    const now = this.clock.now();
    const record = await this.prisma.withTx(async (tx) => {
      const latest = await tx.parkingTariff.findFirst({ orderBy: { version: 'desc' } });
      const version = (latest?.version ?? 0) + 1;
      const created = await tx.parkingTariff.create({
        data: {
          id: uuidv7(),
          version,
          activeFrom: input.activeFrom,
          config: parsed.config as unknown as Prisma.InputJsonObject,
          createdById: actor.id,
          createdAt: now,
        },
      });
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'parking_tariff.create',
          entityType: 'parking_tariff',
          entityId: created.id,
          after: { version, activeFrom: input.activeFrom.toISOString(), config: parsed.config },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return created;
    });
    this.invalidate();
    this.logger.log(
      `Parking tariff v${record.version} created, active from ${input.activeFrom.toISOString()}`,
    );
    return this.toRecord(record);
  }

  invalidate(): void {
    this.cache = null;
  }

  private async loadAll(): Promise<TariffRecord[]> {
    const nowMs = this.clock.nowMs();
    if (this.cache && this.cache.loadedAt + TARIFF_CACHE_TTL_MS > nowMs) {
      return this.cache.tariffs;
    }
    const rows = await this.prisma.parkingTariff.findMany({ orderBy: { activeFrom: 'desc' } });
    const tariffs = rows.map((row) => this.toRecord(row));
    this.cache = { loadedAt: nowMs, tariffs };
    return tariffs;
  }

  private toRecord(row: {
    id: string;
    version: number;
    activeFrom: Date;
    config: Prisma.JsonValue;
    createdById: string | null;
    createdAt: Date;
  }): TariffRecord {
    const parsed = parseTariffConfig(row.config);
    if (!parsed.ok) {
      this.logger.warn(`Parking tariff v${row.version} has an invalid config; using defaults`);
    }
    return {
      id: row.id,
      version: row.version,
      activeFrom: row.activeFrom,
      config: tariffConfigOrDefault(row.config),
      createdById: row.createdById,
      createdAt: row.createdAt,
    };
  }
}
