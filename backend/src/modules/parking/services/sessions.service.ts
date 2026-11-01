import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Vehicle } from '@prisma/client';
import {
  FEATURE_FLAGS_PORT,
  FEATURE_FLAG_KEYS,
  type FeatureFlagsPort,
} from '../../../common/contracts/admin';
import type { ParkingDisputeReason, ParkingSessionStatus } from '../../../common/contracts/parking';
import { PAYMENTS_PORT, type PaymentsPort } from '../../../common/contracts/payments';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { type AirRaidView, airRaidView } from '../domain/air-raid';
import { ParkingErrors } from '../domain/errors';
import {
  type HeroAction,
  type HeroState,
  type HeroTimings,
  type ParkingMode,
  heroActions,
  heroState,
} from '../domain/hero';
import {
  LISTED_PAYMENT_STATUSES,
  type PaidVia,
  type SessionPaymentView,
  appPaidKopecks,
  kyivMonthRange,
  paidVia,
} from '../domain/history';
import { type ParkingNotice, parkingNotices } from '../domain/notices';
import { disputedEvent } from '../domain/parking-events';
import { formatPlate } from '../domain/plate';
import {
  ACTIVE_SESSION_STATUSES,
  CLOSE_REASONS,
  FINAL_SESSION_STATUSES,
  isFinalStatus,
} from '../domain/session-state';
import { type SessionRecord, type SessionView, buildSessionView } from '../domain/session-view';
import { HOUR_MS, MINUTE_MS } from '../domain/tariff';
import { VERIFICATION_CODE_PATTERN } from '../domain/verification';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';
import type { ProviderSessionSnapshot } from '../provider/parking-provider.port';
import { AirRaidService } from './air-raid.service';
import { type LookupDecision, UnverifiedLookupLimiter } from './lookup-limiter';
import { SessionSyncService } from './session-sync.service';
import { TariffService } from './tariff.service';
import { type VehicleView, VehiclesService, toVehicleView } from './vehicles.service';

/** Talon claims per member per hour (POST /parking/sessions/claim). */
export const CLAIMS_PER_HOUR = 10;

/** Session of an unverified plate: only the amount and the paid period (brief section 8). */
export interface RestrictedSessionView {
  vehicleId: string;
  plate: string;
  plateDisplay: string;
  amountDueKopecks: number;
  paidUntil: Date | null;
}

/** GET /parking/session: everything the parking hero (F0-F7, I0-I4) needs in one response. */
export interface ParkingHero {
  mode: ParkingMode;
  heroState: HeroState;
  actions: HeroAction[];
  serverTime: Date;
  infoModeEnabled: boolean;
  /** False when the operator could not be reached: the session is shown as of `lastSyncedAt`. */
  providerAvailable: boolean;
  defaultVehicle: VehicleView | null;
  vehicles: VehicleView[];
  session: SessionView | null;
  restricted: RestrictedSessionView | null;
  /** Present when unverified plates were looked up (or the quota is exhausted). */
  lookupQuota: { limit: number; remaining: number; resetAt: Date } | null;
  airRaid: AirRaidView;
  notices: ParkingNotice[];
  tariffVersion: number;
}

export interface HistoryItem {
  id: string;
  source: SessionRecord['source'];
  status: ParkingSessionStatus;
  plate: string | null;
  plateDisplay: string | null;
  zone: SessionRecord['zone'];
  enteredAt: Date;
  exitedAt: Date | null;
  paidUntil: Date | null;
  durationMinutes: number;
  amountPaidKopecks: number;
  stayTotalKopecks: number;
  closedReason: string | null;
  /** app | paymat | free | none */
  paidVia: PaidVia;
  /** App payments that moved money for this stay (kept or refunded), oldest first. */
  paymentIds: string[];
  disputed: boolean;
}

export interface HistoryQuery {
  cursor?: string;
  limit: number;
  /** Entries with enteredAt >= from. */
  from?: Date;
  /** Entries with enteredAt < to. */
  to?: Date;
}

/** GET /parking/history/summary?month=YYYY-MM («Жовтень: 6 візитів, 9 год 40 хв, 340 ₴»). */
export interface HistorySummary {
  month: string;
  from: Date;
  to: Date;
  visits: number;
  totalPaidKopecks: number;
  totalDurationMinutes: number;
}

interface HistoryCursor {
  e: string;
  i: string;
  [key: string]: string;
}

function isHistoryCursor(value: unknown): value is HistoryCursor {
  const candidate = value as Partial<HistoryCursor> | null;
  return (
    !!candidate &&
    typeof candidate.e === 'string' &&
    typeof candidate.i === 'string' &&
    !Number.isNaN(new Date(candidate.e).getTime())
  );
}

interface LinkedPayment extends SessionPaymentView {
  refundedKopecks: number;
}

/**
 * Member-facing session reads and actions: picks the session to show (operator session first,
 * then the info-mode timer, then a recently closed one; disputed sessions never), refreshes it
 * from the operator when stale, applies the quota for unverified plates and computes the hero;
 * «Я вже виїхав», «Так, я тут» (F7), «Це не моє авто» (F2), claiming a session with its talon,
 * the history and its monthly summary.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  /** Plates the operator recently reported as "not inside" (avoids a lookup on every poll). */
  private readonly noSessionUntil = new Map<string, number>();
  /** Epoch ms until which the operator is treated as unavailable after a failed call. */
  private providerFailedUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly sync: SessionSyncService,
    private readonly tariffs: TariffService,
    private readonly vehicles: VehiclesService,
    private readonly airRaid: AirRaidService,
    private readonly limiter: UnverifiedLookupLimiter,
    private readonly outbox: OutboxService,
    @Inject(FEATURE_FLAGS_PORT) private readonly flags: FeatureFlagsPort,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  heroTimings(): HeroTimings {
    return {
      recentClosedHours: this.config.PARKING_RECENT_CLOSED_HOURS,
      stillInsidePayableHours: 5,
      stillInsideOverstayHours: 2,
    };
  }

  async infoModeEnabled(): Promise<boolean> {
    return this.flags.isEnabled(
      FEATURE_FLAG_KEYS.parkingInfoMode,
      this.config.PARKING_INFO_MODE_DEFAULT,
    );
  }

  async getHero(userId: string): Promise<ParkingHero> {
    const [vehicleRows, infoModeEnabled, alert] = await Promise.all([
      this.vehicles.listRows(userId),
      this.infoModeEnabled(),
      this.airRaid.current(),
    ]);
    const now = this.clock.now();
    const tariff = await this.tariffs.getActiveTariff(now);
    const verified = vehicleRows.filter((vehicle) => vehicle.verified);
    const unverified = vehicleRows.filter((vehicle) => !vehicle.verified);
    let providerAvailable = true;

    // An operator that failed recently (or the vendor stub in Release 1) is asked at most once
    // per stale window instead of on every poll; the hero is served from the database meanwhile.
    if (this.clock.nowMs() < this.providerFailedUntil) {
      providerAvailable = false;
    }

    // 1. The member's operator session (refreshed when the local copy is stale).
    let active = await this.findActive(userId, 'provider');
    if (active && providerAvailable && this.sync.isStale(active, now)) {
      try {
        active = await this.sync.refresh(active);
      } catch (error) {
        providerAvailable = false;
        this.providerFailed(error, 'refresh');
      }
    }
    if (active && isFinalStatus(active.status)) {
      active = null;
    }
    // 2. No stored session yet: ask the operator about the verified plates.
    if (!active && providerAvailable && verified.length > 0) {
      for (const vehicle of verified) {
        if (!this.shouldLookup(vehicle.plate)) {
          continue;
        }
        try {
          const found = await this.sync.lookupPlate(vehicle.plate);
          if (
            found &&
            !isFinalStatus(found.status) &&
            found.userId === userId &&
            !found.disputedAt
          ) {
            active = found;
            break;
          }
          this.rememberNoSession(vehicle.plate);
        } catch (error) {
          providerAvailable = false;
          this.providerFailed(error, 'lookup');
          break;
        }
      }
    }
    // 3. Info-mode timer, 4. a session closed less than two hours ago.
    const shown =
      active ??
      (await this.findActive(userId, 'info_timer')) ??
      (await this.findRecentlyClosed(userId, now));

    // 5. Unverified plates: amount and paid period only, within the hourly quota.
    let restricted: RestrictedSessionView | null = null;
    let restrictedStatus: { status: ParkingSessionStatus; enteredAt: Date } | null = null;
    let lookupQuota: LookupDecision | null = null;
    const nothingActive = !shown || isFinalStatus(shown.status);
    if (nothingActive && unverified.length > 0) {
      lookupQuota = await this.limiter.consume(
        userId,
        this.config.PARKING_UNVERIFIED_LOOKUPS_PER_HOUR,
      );
      if (!lookupQuota.allowed) {
        // Without anything else to show (full mode, no verified vehicle) the request itself is
        // over the limit; otherwise the hero is served without the restricted part.
        if (!infoModeEnabled && verified.length === 0 && !shown) {
          throw new DomainError(
            ParkingErrors.PC_PARKING_LOOKUP_LIMIT,
            `Unverified plates can be looked up ${lookupQuota.limit} times per hour; verify the vehicle with a talon or paymat code`,
            { details: { limit: lookupQuota.limit, resetAt: lookupQuota.resetAt.toISOString() } },
          );
        }
      } else {
        const found = await this.restrictedLookup(unverified, now, providerAvailable);
        if (found.unavailable) {
          providerAvailable = false;
        }
        if (found.view) {
          restricted = found.view.restricted;
          restrictedStatus = found.view.facts;
        }
      }
    }

    const sessionView = shown
      ? buildSessionView(shown, {
          now,
          tariff: tariff.config,
          airRaid: alert,
          payMinMinutesLeft: this.config.PARKING_PAY_MIN_MINUTES_LEFT,
          payments: (await this.paymentsBySession([shown.id])).get(shown.id) ?? [],
        })
      : null;
    const mode: ParkingMode = infoModeEnabled ? 'info' : 'full';
    const state = heroState({
      mode,
      hasVehicles: vehicleRows.length > 0,
      session: sessionView
        ? {
            source: sessionView.source,
            status: sessionView.status,
            enteredAt: sessionView.enteredAt,
            paidUntil: sessionView.paidUntil,
            exitedAt: sessionView.exitedAt,
            presenceConfirmedAt: sessionView.presenceConfirmedAt,
          }
        : restricted && restrictedStatus
          ? {
              source: 'provider',
              status: restrictedStatus.status,
              enteredAt: restrictedStatus.enteredAt,
              paidUntil: restricted.paidUntil,
              exitedAt: null,
            }
          : null,
      now,
      timings: this.heroTimings(),
    });
    const sessionVerified = sessionView ? true : !restricted;
    const activeZone = sessionView && !isFinalStatus(sessionView.status) ? sessionView.zone : null;
    const defaultRow = vehicleRows.find((vehicle) => vehicle.isDefault) ?? vehicleRows[0] ?? null;

    return {
      mode,
      heroState: state,
      actions: heroActions(state, {
        verified: sessionVerified,
        infoModeEnabled,
        hasUnverifiedVehicles: unverified.length > 0,
      }),
      serverTime: now,
      infoModeEnabled,
      providerAvailable,
      defaultVehicle: defaultRow ? toVehicleView(defaultRow) : null,
      vehicles: vehicleRows.map(toVehicleView),
      session: sessionView,
      restricted,
      lookupQuota: lookupQuota
        ? {
            limit: lookupQuota.limit,
            remaining: lookupQuota.remaining,
            resetAt: lookupQuota.resetAt,
          }
        : null,
      airRaid: airRaidView(alert, now),
      notices: parkingNotices({
        now,
        tariff: tariff.config,
        airRaidActive: alert !== null,
        activeZone,
      }),
      tariffVersion: tariff.version,
    };
  }

  /** «Я вже виїхав»: closes the session as left now; nothing is charged automatically. */
  async markLeft(userId: string, sessionId: string): Promise<SessionView> {
    const record = await this.getOwned(userId, sessionId);
    if (isFinalStatus(record.status)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'The parking session is already closed',
        { details: { sessionId, status: record.status } },
      );
    }
    const reason = record.source === 'info_timer' ? CLOSE_REASONS.userExit : CLOSE_REASONS.userLeft;
    const result = await this.sync.updateFacts(record, {
      exitedAt: this.clock.now(),
      closedReason: reason,
    });
    return this.view(result.record ?? record);
  }

  /**
   * F7 «Так, я тут»: the member confirms the car is still inside; the "still inside?" thresholds
   * (5 h payable, 2 h overstay) count from now. Does not touch the facts or the sync marker.
   */
  async confirmPresence(userId: string, sessionId: string): Promise<ParkingHero> {
    const record = await this.getOwned(userId, sessionId);
    if (isFinalStatus(record.status)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'The parking session is already closed',
        { details: { sessionId, status: record.status } },
      );
    }
    await this.prisma.parkingSession.updateMany({
      where: { id: record.id, userId },
      data: { presenceConfirmedAt: this.clock.now() },
    });
    return this.getHero(userId);
  }

  /**
   * F2 «Це не моє авто» (and «сума неправильна», «шлагбаум не відкрився»): the session is marked
   * disputed, disappears from the hero, stops sending reminders and `parking.session.disputed`
   * is published for support. Repeating the call changes nothing.
   */
  async dispute(
    userId: string,
    sessionId: string,
    input: { reason: ParkingDisputeReason; comment?: string | null },
  ): Promise<ParkingHero> {
    const record = await this.getOwned(userId, sessionId);
    if (!record.disputedAt) {
      const disputedAt = this.clock.now();
      const comment = input.comment?.trim() ? input.comment.trim().slice(0, 500) : null;
      await this.prisma.withTx(async (tx) => {
        const updated = await tx.parkingSession.updateMany({
          where: { id: record.id, userId, disputedAt: null },
          data: { disputedAt, disputeReason: input.reason, disputeComment: comment },
        });
        if (updated.count === 1) {
          await this.outbox.publish(
            tx,
            disputedEvent(record, { reason: input.reason, comment, disputedAt }),
          );
        }
      });
      this.logger.warn(`Session ${record.id} disputed by its member (${input.reason})`);
    }
    return this.getHero(userId);
  }

  /**
   * Claims an operator session with its entry talon (cars the camera did not read, or before the
   * plate is verified): the operator confirms the talon, the session is attached to the member
   * (talon-only sessions are stored with plate null) and the hero is returned. 10 claims per hour.
   */
  async claimByTalon(userId: string, talonCode: string): Promise<ParkingHero> {
    const code = talonCode.trim();
    if (!VERIFICATION_CODE_PATTERN.test(code)) {
      throw new DomainError(
        CommonErrors.PC_COMMON_VALIDATION,
        'The talon code has an unexpected format',
        {
          details: [
            { path: 'talonCode', messages: ['talonCode must be 4-32 letters, digits or dashes'] },
          ],
        },
      );
    }
    const quota = await this.limiter.consumeWindow(`claim:${userId}`, CLAIMS_PER_HOUR, HOUR_MS);
    if (!quota.allowed) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_CLAIM_LIMIT,
        `A member can claim ${quota.limit} talons per hour`,
        { details: { limit: quota.limit, resetAt: quota.resetAt.toISOString() } },
      );
    }
    let snapshot: ProviderSessionSnapshot | null;
    try {
      snapshot = await this.sync.findByTalon(code);
    } catch (error) {
      throw DomainError.is(error)
        ? error
        : new DomainError(
            ParkingErrors.PC_PARKING_PROVIDER_UNAVAILABLE,
            'The parking operator is unavailable; pay at the paymat',
            { cause: error },
          );
    }
    if (!snapshot) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_TALON_UNKNOWN,
        'The operator knows no active session for this talon',
      );
    }
    const stored = await this.prisma.parkingSession.findUnique({
      where: { providerRef: snapshot.providerRef },
    });
    if (stored?.userId && stored.userId !== userId) {
      throw this.claimedElsewhere(snapshot.providerRef);
    }
    if (stored && isFinalStatus(stored.status)) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_INVALID_TRANSITION,
        'The parking session is already closed',
        { details: { status: stored.status } },
      );
    }
    let vehicleId: string | null = null;
    if (snapshot.plate) {
      const owners = await this.prisma.vehicle.findMany({
        where: { plate: snapshot.plate, deletedAt: null },
      });
      if (owners.some((vehicle) => vehicle.verified && vehicle.userId !== userId)) {
        throw this.claimedElsewhere(snapshot.providerRef);
      }
      vehicleId = owners.find((vehicle) => vehicle.userId === userId)?.id ?? null;
    }
    const result = await this.sync.applySnapshot(snapshot, { claimFor: { userId, vehicleId } });
    if (result.record && !result.record.userId) {
      // The row existed without an owner (an unverified plate): attach it now.
      await this.prisma.parkingSession.updateMany({
        where: { id: result.record.id, userId: null },
        data: { userId, vehicleId },
      });
    }
    this.noSessionUntil.clear();
    this.logger.log(`Member ${userId} claimed operator session ${snapshot.providerRef} by talon`);
    return this.getHero(userId);
  }

  async history(userId: string, query: HistoryQuery): Promise<Page<HistoryItem>> {
    const cursor = decodeCursor(query.cursor, isHistoryCursor);
    const enteredAt =
      query.from || query.to
        ? { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) }
        : undefined;
    const rows = await this.prisma.parkingSession.findMany({
      where: {
        userId,
        ...(enteredAt ? { enteredAt } : {}),
        ...(cursor
          ? {
              OR: [
                { enteredAt: { lt: new Date(cursor.e) } },
                { enteredAt: new Date(cursor.e), id: { lt: cursor.i } },
              ],
            }
          : {}),
      },
      orderBy: [{ enteredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const now = this.clock.now();
    const { config } = await this.tariffs.getActiveTariff(now);
    const page = toPage(rows, query.limit, (last) => ({
      e: last.enteredAt.toISOString(),
      i: last.id,
    }));
    const linked = await this.paymentsBySession(page.items.map((row) => row.id));
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((row) => {
        const view = buildSessionView(row, { now, tariff: config });
        const payments = linked.get(row.id) ?? [];
        return {
          id: view.id,
          source: view.source,
          status: view.status,
          plate: view.plate,
          plateDisplay: view.plateDisplay,
          zone: view.zone,
          enteredAt: view.enteredAt,
          exitedAt: view.exitedAt,
          paidUntil: view.paidUntil,
          durationMinutes: view.durationMinutes,
          amountPaidKopecks: view.amountPaidKopecks,
          stayTotalKopecks: view.stayTotalKopecks,
          closedReason: view.closedReason,
          paidVia: paidVia({
            status: view.status,
            source: view.source,
            paidUntil: view.paidUntil,
            amountPaidKopecks: view.amountPaidKopecks,
            stayTotalKopecks: view.stayTotalKopecks,
            appPaidKopecks: appPaidKopecks(payments),
          }),
          paymentIds: payments
            .filter((payment) => LISTED_PAYMENT_STATUSES.includes(payment.status))
            .map((payment) => payment.id),
          disputed: view.disputedAt !== null,
        };
      }),
    };
  }

  /** Totals of a Kyiv calendar month: visits (disputed stays excluded), money paid, time parked. */
  async historySummary(userId: string, month: string): Promise<HistorySummary> {
    const range = kyivMonthRange(month);
    if (!range) {
      throw new DomainError(CommonErrors.PC_COMMON_VALIDATION, 'month must be YYYY-MM', {
        details: [{ path: 'month', messages: ['month must be YYYY-MM'] }],
      });
    }
    const rows = await this.prisma.parkingSession.findMany({
      where: { userId, disputedAt: null, enteredAt: { gte: range.from, lt: range.to } },
      select: { enteredAt: true, exitedAt: true, amountPaidKopecks: true },
    });
    const now = this.clock.nowMs();
    let totalDurationMinutes = 0;
    let totalPaidKopecks = 0;
    for (const row of rows) {
      const end = row.exitedAt ? row.exitedAt.getTime() : now;
      totalDurationMinutes += Math.max(0, Math.floor((end - row.enteredAt.getTime()) / MINUTE_MS));
      totalPaidKopecks += row.amountPaidKopecks;
    }
    return {
      month,
      from: range.from,
      to: range.to,
      visits: rows.length,
      totalPaidKopecks,
      totalDurationMinutes,
    };
  }

  async getOwned(userId: string, sessionId: string): Promise<SessionRecord> {
    const record = await this.prisma.parkingSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!record) {
      throw new DomainError(
        ParkingErrors.PC_PARKING_SESSION_NOT_FOUND,
        'Parking session not found',
        {
          details: { sessionId },
        },
      );
    }
    return record;
  }

  async view(record: SessionRecord): Promise<SessionView> {
    const now = this.clock.now();
    const [{ config }, alert, linked] = await Promise.all([
      this.tariffs.getActiveTariff(now),
      this.airRaid.current(),
      this.paymentsBySession([record.id]),
    ]);
    return buildSessionView(record, {
      now,
      tariff: config,
      airRaid: alert,
      payMinMinutesLeft: this.config.PARKING_PAY_MIN_MINUTES_LEFT,
      payments: linked.get(record.id) ?? [],
    });
  }

  // --- internals --------------------------------------------------------------------------------

  /** App payments linked to the sessions (attempts included), oldest first, read via PAYMENTS_PORT. */
  private async paymentsBySession(sessionIds: string[]): Promise<Map<string, LinkedPayment[]>> {
    const result = new Map<string, LinkedPayment[]>();
    if (sessionIds.length === 0) {
      return result;
    }
    const links = await this.prisma.parkingPaymentLink.findMany({
      where: { sessionId: { in: sessionIds } },
      orderBy: { createdAt: 'asc' },
    });
    if (links.length === 0) {
      return result;
    }
    const payments = new Map(
      (await this.payments.getPayments(links.map((link) => link.paymentId))).map((payment) => [
        payment.id,
        payment,
      ]),
    );
    for (const link of links) {
      const payment = payments.get(link.paymentId);
      if (!payment) {
        continue;
      }
      const metaPaidUntil =
        typeof payment.meta['paidUntil'] === 'string' ? new Date(payment.meta['paidUntil']) : null;
      const entry: LinkedPayment = {
        id: payment.id,
        amountKopecks: payment.amountKopecks,
        paidAt: payment.paidAt,
        paidUntil:
          link.paidUntil ??
          (metaPaidUntil && !Number.isNaN(metaPaidUntil.getTime()) ? metaPaidUntil : null),
        status: payment.status,
        refundedKopecks: payment.refundedKopecks,
      };
      result.set(link.sessionId, [...(result.get(link.sessionId) ?? []), entry]);
    }
    return result;
  }

  private async findActive(
    userId: string,
    source: SessionRecord['source'],
  ): Promise<SessionRecord | null> {
    return this.prisma.parkingSession.findFirst({
      where: { userId, source, disputedAt: null, status: { in: ACTIVE_SESSION_STATUSES } },
      orderBy: { enteredAt: 'desc' },
    });
  }

  private async findRecentlyClosed(userId: string, now: Date): Promise<SessionRecord | null> {
    const hours = this.config.PARKING_RECENT_CLOSED_HOURS;
    if (hours <= 0) {
      return null;
    }
    return this.prisma.parkingSession.findFirst({
      where: {
        userId,
        disputedAt: null,
        status: { in: [...FINAL_SESSION_STATUSES] },
        exitedAt: { gte: new Date(now.getTime() - hours * HOUR_MS) },
      },
      orderBy: { exitedAt: 'desc' },
    });
  }

  private async restrictedLookup(
    vehicles: Vehicle[],
    now: Date,
    providerAvailable: boolean,
  ): Promise<{
    unavailable: boolean;
    view: {
      restricted: RestrictedSessionView;
      facts: { status: ParkingSessionStatus; enteredAt: Date };
    } | null;
  }> {
    let unavailable = !providerAvailable;
    const { config } = await this.tariffs.getActiveTariff(now);
    for (const vehicle of vehicles) {
      let record: SessionRecord | null = await this.prisma.parkingSession.findFirst({
        where: {
          plate: vehicle.plate,
          source: 'provider',
          disputedAt: null,
          status: { in: ACTIVE_SESSION_STATUSES },
        },
        orderBy: { enteredAt: 'desc' },
      });
      if (!unavailable && (!record || this.sync.isStale(record, now))) {
        try {
          record = record
            ? await this.sync.refresh(record)
            : await this.sync.lookupPlate(vehicle.plate);
        } catch (error) {
          unavailable = true;
          this.providerFailed(error, 'restricted lookup');
        }
      }
      if (record && !isFinalStatus(record.status) && !record.disputedAt) {
        const view = buildSessionView(record, { now, tariff: config });
        return {
          unavailable,
          view: {
            restricted: {
              vehicleId: vehicle.id,
              plate: vehicle.plate,
              plateDisplay: vehicle.plateDisplay || formatPlate(vehicle.plate),
              amountDueKopecks: view.amountDueKopecks,
              paidUntil: view.paidUntil,
            },
            facts: { status: view.status, enteredAt: view.enteredAt },
          },
        };
      }
    }
    return { unavailable, view: null };
  }

  private claimedElsewhere(providerRef: string): DomainError {
    return new DomainError(
      ParkingErrors.PC_PARKING_SESSION_CLAIMED,
      'This parking session belongs to another account; contact support',
      { details: { providerRef } },
    );
  }

  private shouldLookup(plate: string): boolean {
    const until = this.noSessionUntil.get(plate);
    return until === undefined || until <= this.clock.nowMs();
  }

  private rememberNoSession(plate: string): void {
    this.noSessionUntil.set(plate, this.clock.nowMs() + this.config.PARKING_SESSION_STALE_MS);
  }

  private providerFailed(error: unknown, operation: string): void {
    this.providerFailedUntil = this.clock.nowMs() + this.config.PARKING_SESSION_STALE_MS;
    this.warnProvider(operation, error);
  }

  private warnProvider(operation: string, error: unknown): void {
    this.logger.warn(
      `Parking operator ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
