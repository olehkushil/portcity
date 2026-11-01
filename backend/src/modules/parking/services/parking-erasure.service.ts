import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ACTIVE_SESSION_STATUSES, FINAL_SESSION_STATUSES } from '../domain/session-state';

/** Prefix of the plate placeholder written over erased vehicles (never a normalised plate). */
export const ERASED_PLATE_PREFIX = 'erased-';

/**
 * Placeholder for an erased vehicle's plate: `erased-` plus the last 9 hex digits of the vehicle
 * id (16 characters, fits plate VarChar(16) and plate_display VarChar(20)). Normalised plates are
 * upper-case Latin letters and digits without dashes, so a placeholder never matches a real
 * plate in operator lookups; it is unique per vehicle, so the partial unique index
 * `vehicles_user_id_plate_live_key` stays satisfied.
 */
export function erasedPlate(vehicleId: string): string {
  return `${ERASED_PLATE_PREFIX}${vehicleId.replace(/-/g, '').slice(-9).toLowerCase()}`;
}

export interface ParkingErasureSummary {
  userId: string;
  /** Vehicles soft-deleted and/or given a placeholder plate in this run. */
  vehiclesErased: number;
  /** Closed sessions whose plate and vehicle link were removed. */
  closedSessionsScrubbed: number;
  /** Still-active sessions detached from the erased account. */
  activeSessionsUnlinked: number;
}

/**
 * `user.deleted` (identity anonymised the account): removes the personal data parking holds.
 * Idempotent: a repeated delivery finds nothing left to change.
 *
 * - Vehicles of the user (live and previously deleted): `deletedAt` set (kept when already set),
 *   `isDefault = false`, plate and display replaced by `erasedPlate(id)`.
 * - Closed sessions of the user: `plate` and `vehicleId` set to null; the anonymised `userId`,
 *   times and amounts stay (history and payment links of an anonymous owner, like the ledger).
 * - Still-active sessions of the user: detached from the account (`userId`, `vehicleId` null) so
 *   nothing is shown to or published for the erased account. Operator sessions keep their plate
 *   and facts: the car is physically inside, the operator keeps reporting it and the row behaves
 *   like a session of an unverified plate (closed by the operator or after
 *   PARKING_SESSION_TTL_HOURS). Info-mode timers belong to the member only, so their plate is
 *   dropped too and the timer is closed by the housekeeping TTL. `lastSyncedAt` is bumped so a
 *   concurrent sync step holding the old row fails its compare-and-set instead of re-linking it.
 * - Sessions stored without an owner (unverified plates) cannot be attributed and stay as they are.
 */
@Injectable()
export class ParkingErasureService {
  private readonly logger = new Logger(ParkingErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async eraseUser(userId: string): Promise<ParkingErasureSummary> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const vehicles = await tx.vehicle.findMany({ where: { userId } });
      let vehiclesErased = 0;
      for (const vehicle of vehicles) {
        const placeholder = erasedPlate(vehicle.id);
        if (
          vehicle.deletedAt &&
          !vehicle.isDefault &&
          vehicle.plate === placeholder &&
          vehicle.plateDisplay === placeholder
        ) {
          continue;
        }
        await tx.vehicle.update({
          where: { id: vehicle.id },
          data: {
            deletedAt: vehicle.deletedAt ?? now,
            isDefault: false,
            plate: placeholder,
            plateDisplay: placeholder,
          },
        });
        vehiclesErased += 1;
      }

      const closed = await tx.parkingSession.updateMany({
        where: {
          userId,
          status: { in: [...FINAL_SESSION_STATUSES] },
          OR: [{ plate: { not: null } }, { vehicleId: { not: null } }],
        },
        data: { plate: null, vehicleId: null, updatedAt: now },
      });

      const timers = await tx.parkingSession.updateMany({
        where: { userId, source: 'info_timer', status: { in: ACTIVE_SESSION_STATUSES } },
        data: { userId: null, vehicleId: null, plate: null, lastSyncedAt: now, updatedAt: now },
      });
      const operator = await tx.parkingSession.updateMany({
        where: { userId, source: 'provider', status: { in: ACTIVE_SESSION_STATUSES } },
        data: { userId: null, vehicleId: null, lastSyncedAt: now, updatedAt: now },
      });

      const summary: ParkingErasureSummary = {
        userId,
        vehiclesErased,
        closedSessionsScrubbed: closed.count,
        activeSessionsUnlinked: timers.count + operator.count,
      };
      if (vehiclesErased + summary.closedSessionsScrubbed + summary.activeSessionsUnlinked > 0) {
        this.logger.log(
          `Erased parking data of user ${userId}: ${vehiclesErased} vehicle(s), ${summary.closedSessionsScrubbed} closed and ${summary.activeSessionsUnlinked} active session(s)`,
        );
      }
      return summary;
    });
  }
}
