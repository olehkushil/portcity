import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Vehicle } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  OUTBOX_AGGREGATES,
  PARKING_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { VehicleVerifiedVia } from '../../../common/contracts/parking';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ParkingErrors } from '../domain/errors';
import { formatPlate, normalisePlate } from '../domain/plate';
import { VERIFICATION_CODE_PATTERN } from '../domain/verification';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';
import { ParkingProviderPort } from '../provider/parking-provider.port';
import { ACTIVE_SESSION_STATUSES } from '../domain/session-state';
import { UnverifiedLookupLimiter } from './lookup-limiter';

/** Verification attempts per member's vehicle (user + plate) in 24 h, on top of 10/h per IP. */
export const VERIFY_ATTEMPTS_PER_VEHICLE = 5;
export const VERIFY_WINDOW_MS = 24 * 3_600_000;

export interface VehicleView {
  id: string;
  plate: string;
  plateDisplay: string;
  /** Member's own name for the car, e.g. «Моя Škoda». */
  label: string | null;
  verified: boolean;
  verifiedVia: VehicleVerifiedVia;
  verifiedAt: Date | null;
  isDefault: boolean;
  createdAt: Date;
}

export interface VerifyVehicleInput {
  talonCode?: string | null;
  paymatCode?: string | null;
}

export interface AddVehicleOptions {
  label?: string | null;
  /** Make the new car the default one («Основне»); the first car always is. */
  makeDefault?: boolean;
}

export function toVehicleView(row: Vehicle): VehicleView {
  return {
    id: row.id,
    plate: row.plate,
    plateDisplay: row.plateDisplay || formatPlate(row.plate),
    label: row.label ?? null,
    verified: row.verified,
    verifiedVia: row.verifiedVia,
    verifiedAt: row.verifiedAt,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  };
}

/**
 * Member vehicles (brief sections 4 and 8): normalised Latin plates, one live row per
 * (user, plate), soft delete, a default vehicle, verification by talon or paymat code through
 * the provider port. Only verified vehicles see full sessions and can pay in the app.
 */
@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly provider: ParkingProviderPort,
    private readonly limiter: UnverifiedLookupLimiter,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  async listRows(userId: string): Promise<Vehicle[]> {
    return this.prisma.vehicle.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async list(userId: string): Promise<VehicleView[]> {
    return (await this.listRows(userId)).map(toVehicleView);
  }

  async add(
    userId: string,
    plateInput: string,
    options: AddVehicleOptions = {},
  ): Promise<VehicleView> {
    const normalised = normalisePlate(plateInput);
    if (!normalised) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_PLATE_INVALID,
        'Plate must contain Latin or look-alike Cyrillic letters and digits, e.g. AC 1234 BC',
        { details: { plate: plateInput } },
      );
    }
    const existing = await this.listRows(userId);
    if (existing.some((vehicle) => vehicle.plate === normalised.plate)) {
      throw this.exists(normalised.plate);
    }
    if (existing.length >= this.config.PARKING_MAX_VEHICLES) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_VEHICLE_LIMIT,
        `A member can keep up to ${this.config.PARKING_MAX_VEHICLES} vehicles`,
        { details: { limit: this.config.PARKING_MAX_VEHICLES } },
      );
    }
    const label = options.label?.trim() ? options.label.trim().slice(0, 40) : null;
    const isDefault = existing.length === 0 || options.makeDefault === true;
    try {
      const row = await this.prisma.withTx(async (tx) => {
        if (isDefault && existing.length > 0) {
          await tx.vehicle.updateMany({
            where: { userId, deletedAt: null, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.vehicle.create({
          data: {
            id: uuidv7(),
            userId,
            plate: normalised.plate,
            plateDisplay: normalised.plateDisplay,
            label,
            verified: false,
            verifiedVia: 'none',
            isDefault,
            createdAt: this.clock.now(),
          },
        });
      });
      return toVehicleView(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw this.exists(normalised.plate);
      }
      throw error;
    }
  }

  async get(userId: string, vehicleId: string): Promise<Vehicle> {
    const row = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, userId, deletedAt: null },
    });
    if (!row) {
      throw new DomainError(ParkingErrors.PC_PARKING_VEHICLE_NOT_FOUND, 'Vehicle not found', {
        details: { vehicleId },
      });
    }
    return row;
  }

  /** Soft delete; a vehicle in an active session stays (design brief S06). */
  async remove(userId: string, vehicleId: string): Promise<void> {
    const row = await this.get(userId, vehicleId);
    const active = await this.prisma.parkingSession.count({
      where: { vehicleId: row.id, status: { in: ACTIVE_SESSION_STATUSES } },
    });
    if (active > 0) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'A vehicle with an active parking session cannot be removed',
        { details: { vehicleId } },
      );
    }
    const now = this.clock.now();
    await this.prisma.withTx(async (tx) => {
      await tx.vehicle.update({
        where: { id: row.id },
        data: { deletedAt: now, isDefault: false },
      });
      if (row.isDefault) {
        const next = await tx.vehicle.findFirst({
          where: { userId, deletedAt: null, id: { not: row.id } },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.vehicle.update({ where: { id: next.id }, data: { isDefault: true } });
        }
      }
    });
  }

  async setDefault(userId: string, vehicleId: string): Promise<VehicleView> {
    const row = await this.get(userId, vehicleId);
    await this.prisma.withTx(async (tx) => {
      await tx.vehicle.updateMany({
        where: { userId, deletedAt: null, isDefault: true, id: { not: row.id } },
        data: { isDefault: false },
      });
      await tx.vehicle.update({ where: { id: row.id }, data: { isDefault: true } });
    });
    return toVehicleView({ ...row, isDefault: true });
  }

  /**
   * Proves the member drives the car: the talon (entry ticket) or the paymat code must match
   * the plate at the operator. On success the vehicle is verified and the operator sessions of
   * this plate already stored anonymously are attached to the member.
   */
  async verify(userId: string, vehicleId: string, input: VerifyVehicleInput): Promise<VehicleView> {
    const talonCode = input.talonCode?.trim() || null;
    const paymatCode = input.paymatCode?.trim() || null;
    if ((talonCode ? 1 : 0) + (paymatCode ? 1 : 0) !== 1) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_VERIFICATION_FAILED,
        'Provide exactly one of talonCode or paymatCode',
        { status: 400, details: { reason: 'one_code_required' } },
      );
    }
    const code = (talonCode ?? paymatCode) as string;
    if (!VERIFICATION_CODE_PATTERN.test(code)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_VERIFICATION_FAILED,
        'The code has an unexpected format',
        { status: 400, details: { reason: 'code_format' } },
      );
    }
    const row = await this.get(userId, vehicleId);
    if (row.verified) {
      return toVehicleView(row);
    }

    const elsewhere = await this.prisma.vehicle.count({
      where: { plate: row.plate, verified: true, deletedAt: null, userId: { not: userId } },
    });
    if (elsewhere > 0) {
      // «Номер уже активний в іншому акаунті — зверніться в підтримку» (design brief S06).
      throw new DomainError(
        ParkingErrors.PC_PARKING_VERIFICATION_FAILED,
        'This plate is verified in another account; contact support',
        { status: 409, details: { reason: 'verified_in_other_account' } },
      );
    }

    // Per-vehicle cap (talon/paymat codes are short): 5 attempts per 24 h for this member's car,
    // in addition to the 10 per hour per IP of the route. Deleting and re-adding does not reset it.
    const quota = await this.limiter.consumeWindow(
      `verify:${userId}:${row.plate}`,
      VERIFY_ATTEMPTS_PER_VEHICLE,
      VERIFY_WINDOW_MS,
    );
    if (!quota.allowed) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_VERIFICATION_LIMIT,
        `A vehicle can be verified ${quota.limit} times in 24 hours; try later or contact support`,
        { details: { limit: quota.limit, resetAt: quota.resetAt.toISOString() } },
      );
    }

    let result: Awaited<ReturnType<ParkingProviderPort['verifyVehicle']>>;
    try {
      result = await this.provider.verifyVehicle({
        plate: row.plate,
        ...(talonCode ? { talonCode } : {}),
        ...(paymatCode ? { paymatCode } : {}),
      });
    } catch (error) {
      throw this.providerFailure('verifyVehicle', error);
    }
    if (result === 'unknown_plate') {
      throw new DomainError(
        ParkingErrors.PC_PARKING_UNKNOWN_PLATE,
        'The parking operator has no record of this plate',
        { details: { plate: row.plate } },
      );
    }
    if (result !== 'verified') {
      throw new DomainError(
        ParkingErrors.PC_PARKING_VERIFICATION_FAILED,
        'The code does not match this plate',
        { details: { reason: 'invalid_code' } },
      );
    }

    const via: VehicleVerifiedVia = talonCode ? 'talon' : 'paymat_code';
    const now = this.clock.now();
    const updated = await this.prisma.withTx(async (tx) => {
      const saved = await tx.vehicle.update({
        where: { id: row.id },
        data: { verified: true, verifiedVia: via, verifiedAt: now },
      });
      await tx.parkingSession.updateMany({
        where: {
          plate: row.plate,
          userId: null,
          source: 'provider',
          status: { in: ACTIVE_SESSION_STATUSES },
        },
        data: { userId, vehicleId: row.id },
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(PARKING_EVENTS.vehicleVerified, OUTBOX_AGGREGATES.vehicle, row.id, {
          vehicleId: row.id,
          userId,
          plate: row.plate,
          verifiedVia: via,
        }),
      );
      return saved;
    });
    this.logger.log(`Vehicle ${row.id} verified via ${via}`);
    return toVehicleView(updated);
  }

  private exists(plate: string): DomainError {
    return new DomainError(
      ParkingErrors.PC_PARKING_VEHICLE_EXISTS,
      'This plate is already in your vehicles',
      { details: { plate } },
    );
  }

  private providerFailure(operation: string, error: unknown): DomainError {
    if (DomainError.is(error)) {
      return error;
    }
    return new DomainError(
      ParkingErrors.PC_PARKING_PROVIDER_UNAVAILABLE,
      `Parking operator call failed (${operation})`,
      { cause: error },
    );
  }
}
