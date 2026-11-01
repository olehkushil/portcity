import { Inject, Injectable } from '@nestjs/common';
import type { ParkingZone } from '../../../common/contracts/parking';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ParkingErrors } from '../domain/errors';
import { ACTIVE_SESSION_STATUSES, CLOSE_REASONS, isFinalStatus } from '../domain/session-state';
import { type SessionRecord, type SessionView, buildSessionView } from '../domain/session-view';
import { HOUR_MS, MINUTE_MS } from '../domain/tariff';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';
import { SessionSyncService } from './session-sync.service';
import { SessionsService } from './sessions.service';
import { TariffService } from './tariff.service';

/** Clock skew tolerated for an entry time "in the future". */
const FUTURE_TOLERANCE_MS = 2 * MINUTE_MS;

function invalid(field: string, message: string): DomainError {
  return new DomainError(CommonErrors.PC_COMMON_VALIDATION, message, {
    details: [{ path: field, messages: [message] }],
  });
}

/**
 * Info mode (design brief 4.2, always on in Release 1): a member-run timer without the operator.
 * I0 start with the zone and the entry time, I1/I2 free and paid time by the tariff, I3 paid at
 * the paymat with the exit deadline from the paymat receipt, I4 left. Gated by the feature flag
 * `parking.info_mode`.
 */
@Injectable()
export class InfoModeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly sync: SessionSyncService,
    private readonly sessions: SessionsService,
    private readonly tariffs: TariffService,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  async start(userId: string, input: { zone: ParkingZone; enteredAt: Date }): Promise<SessionView> {
    if (!(await this.sessions.infoModeEnabled())) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INFO_MODE_DISABLED,
        'The parking timer is switched off',
      );
    }
    const enteredAt = this.checkEnteredAt(input.enteredAt);

    const running = await this.prisma.parkingSession.findFirst({
      where: { userId, source: 'info_timer', status: { in: ACTIVE_SESSION_STATUSES } },
    });
    if (running) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_SESSION_ACTIVE_EXISTS,
        'A parking timer is already running; finish it first',
        { details: { sessionId: running.id } },
      );
    }
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    const record = await this.sync.createInfoTimer({
      userId,
      vehicleId: vehicle?.id ?? null,
      plate: vehicle?.plate ?? null,
      zone: input.zone,
      enteredAt,
    });
    return this.sessions.view(record);
  }

  /** I3: paid at the paymat; the exit deadline defaults to the end of the running hour. */
  async paidAtPaymat(
    userId: string,
    sessionId: string,
    input: { paidUntil?: Date | null },
  ): Promise<SessionView> {
    const record = await this.getTimer(userId, sessionId);
    const now = this.clock.now();
    const { config } = await this.tariffs.getActiveTariff(now);
    const current = buildSessionView(record, { now, tariff: config });
    const paidUntil = input.paidUntil ?? current.currentHourEndsAt;
    if (paidUntil.getTime() <= record.enteredAt.getTime()) {
      throw invalid('paidUntil', 'paidUntil must be after the entry time');
    }
    if (paidUntil.getTime() > now.getTime() + 25 * HOUR_MS) {
      throw invalid('paidUntil', 'paidUntil is too far in the future');
    }
    const result = await this.sync.updateFacts(record, { paidUntil });
    return this.sessions.view(result.record ?? record);
  }

  /**
   * Corrects a running timer: the entry time («я заїхав раніше») and/or the zone. The same
   * limits as at the start apply; the entry must stay before an already stated paidUntil.
   */
  async update(
    userId: string,
    sessionId: string,
    input: { enteredAt?: Date | null; zone?: ParkingZone | null },
  ): Promise<SessionView> {
    if (!input.enteredAt && !input.zone) {
      throw invalid('enteredAt', 'Provide enteredAt and/or zone');
    }
    const record = await this.getTimer(userId, sessionId);
    let enteredAt: Date | undefined;
    if (input.enteredAt) {
      enteredAt = this.checkEnteredAt(input.enteredAt);
      if (record.paidUntil && enteredAt.getTime() >= record.paidUntil.getTime()) {
        throw invalid('enteredAt', 'enteredAt must be before the paid-until time');
      }
    }
    const result = await this.sync.updateFacts(record, {
      ...(enteredAt ? { enteredAt } : {}),
      ...(input.zone ? { zone: input.zone } : {}),
    });
    return this.sessions.view(result.record ?? record);
  }

  /** Discards a timer started by mistake: the row is deleted, nothing stays in the history. */
  async discard(userId: string, sessionId: string): Promise<void> {
    const deleted = await this.prisma.parkingSession.deleteMany({
      where: { id: sessionId, userId, source: 'info_timer' },
    });
    if (deleted.count === 0) {
      throw new DomainError(ParkingErrors.PC_PARKING_SESSION_NOT_FOUND, 'Parking timer not found', {
        details: { sessionId },
      });
    }
  }

  /** I4: the member left; the timer closes with an approximate total. */
  async exit(userId: string, sessionId: string): Promise<SessionView> {
    const record = await this.getTimer(userId, sessionId);
    const result = await this.sync.updateFacts(record, {
      exitedAt: this.clock.now(),
      closedReason: CLOSE_REASONS.userExit,
    });
    return this.sessions.view(result.record ?? record);
  }

  /** Not in the future (2 min clock skew tolerated, clamped to now), not older than the TTL. */
  private checkEnteredAt(value: Date): Date {
    const now = this.clock.now();
    if (value.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
      throw invalid('enteredAt', 'enteredAt cannot be in the future');
    }
    if (now.getTime() - value.getTime() > this.config.PARKING_SESSION_TTL_HOURS * HOUR_MS) {
      throw invalid(
        'enteredAt',
        `enteredAt cannot be more than ${this.config.PARKING_SESSION_TTL_HOURS} hours ago`,
      );
    }
    return value.getTime() > now.getTime() ? now : value;
  }

  private async getTimer(userId: string, sessionId: string): Promise<SessionRecord> {
    const record = await this.prisma.parkingSession.findFirst({
      where: { id: sessionId, userId, source: 'info_timer' },
    });
    if (!record) {
      throw new DomainError(ParkingErrors.PC_PARKING_SESSION_NOT_FOUND, 'Parking timer not found', {
        details: { sessionId },
      });
    }
    if (isFinalStatus(record.status)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'The parking timer is already finished',
        { details: { sessionId, status: record.status } },
      );
    }
    return record;
  }
}
