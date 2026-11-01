import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { ParkingSessionSource, ParkingZone } from '../../../common/contracts/parking';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { type AirRaidAlert, airRaidCloseReason } from '../domain/air-raid';
import { reminderEvent, transitionEvents } from '../domain/parking-events';
import { type SessionFactsInput, planSession } from '../domain/reconcile';
import { type ReminderSettings, dueReminders } from '../domain/reminders';
import { ACTIVE_SESSION_STATUSES, CLOSE_REASONS, isFinalStatus } from '../domain/session-state';
import { type SessionLocation, type SessionRecord, mergeLocation } from '../domain/session-view';
import { HOUR_MS, quote } from '../domain/tariff';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';
import {
  ParkingProviderPort,
  type ProviderSessionSnapshot,
  type ProviderWebhookRequest,
} from '../provider/parking-provider.port';
import { AirRaidService } from './air-raid.service';
import { TariffService } from './tariff.service';

export interface ApplyResult {
  /** The stored session after the step, or null for an untracked plate. */
  record: SessionRecord | null;
  /** False when the plate belongs to no live vehicle (nothing is stored). */
  tracked: boolean;
  changed: boolean;
  /** Outbox event types published by this step. */
  events: string[];
  /** True when a concurrent writer changed the row first and this step was not applied. */
  conflict?: boolean;
}

export interface FactsPatch {
  exitedAt?: Date | null;
  paidUntil?: Date | null;
  closedReason?: string | null;
  amountPaidKopecks?: number;
  /** Info-mode timers only: the member corrects the entry time or the zone. */
  enteredAt?: Date;
  zone?: ParkingZone;
}

export interface WebhookOutcome {
  eventId: string;
  type: string;
  tracked: boolean;
  sessionId: string | null;
  status: SessionRecord['status'] | null;
  changed: boolean;
  /** True when this provider event id was already handled (nothing was applied again). */
  duplicate: boolean;
}

/** Explicit owner for a session claimed with its talon (POST /parking/sessions/claim). */
export interface ClaimOwner {
  userId: string;
  vehicleId: string | null;
}

const MAX_LOCAL_ATTEMPTS = 3;

interface Owner {
  tracked: boolean;
  userId: string | null;
  vehicleId: string | null;
}

interface ApplyInput {
  previous: SessionRecord | null;
  create: { providerRef: string | null; source: ParkingSessionSource } | null;
  plate: string | null;
  zone: ParkingZone;
  /** Level / row to store (operator report merged with the stored values). */
  location: SessionLocation;
  link: { userId: string | null; vehicleId: string | null };
  facts: SessionFactsInput;
  now: Date;
  alert: AirRaidAlert | null;
  paymentId: string | null;
  publish: boolean;
}

const NO_LOCATION: SessionLocation = { level: null, spot: null };

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * The single write path for parking sessions. Provider snapshots (sync job, webhooks, on-demand
 * refresh), info-mode actions, "I already left", payments and housekeeping all end up in
 * `applyFacts`, which:
 * 1. leaves closed sessions untouched (a closed status is final);
 * 2. applies the air-raid rule to exits;
 * 3. plans the next state with the pure `planSession` (domain/reconcile.ts);
 * 4. finds reminders crossed since the previous evaluation (domain/reminders.ts);
 * 5. writes with a compare-and-set on (status, lastSyncedAt), so concurrent writers never publish
 *    the same transition twice, and publishes the outbox events in the same transaction.
 * Paid facts are merged monotonically (the later paidUntil and the larger paid amount win), so a
 * provider that lags behind an app payment cannot take the paid period back.
 */
@Injectable()
export class SessionSyncService {
  private readonly logger = new Logger(SessionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly provider: ParkingProviderPort,
    private readonly tariffs: TariffService,
    private readonly airRaid: AirRaidService,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  reminderSettings(): ReminderSettings {
    return {
      freeEndingMinutes: this.config.PARKING_FREE_ENDING_REMINDER_MINUTES,
      exitSoonMinutes: this.config.PARKING_EXIT_REMINDER_MINUTES,
      stillInsidePayableHours: 5,
      stillInsideOverstayHours: 2,
    };
  }

  /** True when the stored copy of a provider session should be refreshed from the operator. */
  isStale(record: SessionRecord, now: Date = this.clock.now()): boolean {
    if (record.source !== 'provider' || isFinalStatus(record.status)) {
      return false;
    }
    return (
      !record.lastSyncedAt ||
      now.getTime() - record.lastSyncedAt.getTime() >= this.config.PARKING_SESSION_STALE_MS
    );
  }

  // --- provider facts ---------------------------------------------------------------------------

  async listActiveSnapshots(): Promise<ProviderSessionSnapshot[]> {
    return this.provider.listActiveSessions();
  }

  /**
   * Snapshots worth storing: plates of live vehicles (verified or not) and sessions already
   * stored. Cars of non-members are never written to the database.
   */
  async filterTracked(snapshots: ProviderSessionSnapshot[]): Promise<ProviderSessionSnapshot[]> {
    if (snapshots.length === 0) {
      return [];
    }
    const plates = [
      ...new Set(snapshots.map((item) => item.plate).filter((p): p is string => !!p)),
    ];
    const refs = snapshots.map((item) => item.providerRef);
    const [vehicles, stored] = await Promise.all([
      plates.length
        ? this.prisma.vehicle.findMany({
            where: { plate: { in: plates }, deletedAt: null },
            select: { plate: true },
          })
        : Promise.resolve([] as { plate: string }[]),
      this.prisma.parkingSession.findMany({
        where: { providerRef: { in: refs } },
        select: { providerRef: true },
      }),
    ]);
    const trackedPlates = new Set(vehicles.map((row) => row.plate));
    const storedRefs = new Set(stored.map((row) => row.providerRef));
    return snapshots.filter(
      (item) => storedRefs.has(item.providerRef) || (item.plate && trackedPlates.has(item.plate)),
    );
  }

  /**
   * Applies one operator snapshot (sync job, webhook, on-demand refresh). `claimFor` attaches a
   * session the member proved with its talon (talon-only sessions are stored with plate null);
   * an owner already stored always wins.
   */
  async applySnapshot(
    snapshot: ProviderSessionSnapshot,
    options: { paymentId?: string | null; claimFor?: ClaimOwner } = {},
    attempt = 0,
  ): Promise<ApplyResult> {
    const now = this.clock.now();
    const previous = await this.prisma.parkingSession.findUnique({
      where: { providerRef: snapshot.providerRef },
    });
    if (previous && isFinalStatus(previous.status)) {
      return { record: previous, tracked: true, changed: false, events: [] };
    }
    const plate = snapshot.plate ?? previous?.plate ?? null;
    const owner: Owner = options.claimFor
      ? { tracked: true, ...options.claimFor }
      : await this.resolveOwner(plate);
    if (!previous && !owner.tracked) {
      return { record: null, tracked: false, changed: false, events: [] };
    }
    const link = previous?.userId
      ? {
          userId: previous.userId,
          vehicleId:
            previous.vehicleId ?? (owner.userId === previous.userId ? owner.vehicleId : null),
        }
      : { userId: owner.userId, vehicleId: owner.vehicleId };
    const alert = snapshot.exitedAt ? await this.airRaid.current() : null;

    try {
      return await this.applyFacts({
        previous,
        create: previous ? null : { providerRef: snapshot.providerRef, source: 'provider' },
        plate,
        zone: snapshot.zone,
        location: mergeLocation(previous ?? NO_LOCATION, snapshot),
        link,
        facts: {
          enteredAt: snapshot.enteredAt,
          exitedAt: snapshot.exitedAt,
          paidUntil: laterOf(snapshot.paidUntil, previous?.paidUntil ?? null),
          closedReason: snapshot.exitedAt ? (snapshot.closedReason ?? CLOSE_REASONS.exit) : null,
          amountPaidKopecks: Math.max(snapshot.amountPaidKopecks, previous?.amountPaidKopecks ?? 0),
        },
        now,
        alert,
        paymentId: options.paymentId ?? null,
        publish: true,
      });
    } catch (error) {
      if (!previous && attempt === 0 && isUniqueViolation(error)) {
        // Another writer stored the same operator session first: apply on top of its row.
        return this.applySnapshot(snapshot, options, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Operator callback (POST /webhooks/parking/:provider): the adapter verifies the signature and
   * parses the body; the provider event id is logged in `parking_webhook_logs` ((provider,
   * eventId) unique), so a redelivered event is acknowledged without being applied again (an
   * old event replayed after newer facts cannot move the session back). The snapshot then goes
   * through the same path as the sync job. A failed application removes the log row so the
   * operator's retry is processed.
   */
  async handleWebhook(
    providerName: string,
    request: ProviderWebhookRequest,
  ): Promise<WebhookOutcome> {
    if (providerName !== this.provider.name) {
      throw new DomainError(
        CommonErrors.PC_COMMON_NOT_FOUND,
        `Parking provider "${providerName}" is not configured`,
        { details: { provider: providerName, configured: this.provider.name } },
      );
    }
    const event = this.provider.parseWebhook(request);
    const key = { provider: this.provider.name, eventId: event.eventId };
    const duplicate = (sessionId: string | null): WebhookOutcome => ({
      eventId: event.eventId,
      type: event.type,
      tracked: sessionId !== null,
      sessionId,
      status: null,
      changed: false,
      duplicate: true,
    });

    const seen = await this.prisma.parkingWebhookLog.findUnique({
      where: { provider_eventId: key },
    });
    if (seen?.processedAt) {
      return duplicate(seen.sessionId);
    }
    let logId = seen?.id ?? null;
    if (!logId) {
      try {
        const log = await this.prisma.parkingWebhookLog.create({
          data: {
            id: uuidv7(),
            ...key,
            type: event.type.slice(0, 50),
            receivedAt: this.clock.now(),
          },
        });
        logId = log.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // A concurrent delivery of the same event is being applied.
          return duplicate(null);
        }
        throw error;
      }
    }

    let result: ApplyResult;
    try {
      result = await this.applySnapshot(event.snapshot);
    } catch (error) {
      await this.prisma.parkingWebhookLog.deleteMany({ where: { id: logId } }).catch(() => {
        // The unprocessed row is re-applied on the next delivery anyway.
      });
      throw error;
    }
    await this.prisma.parkingWebhookLog.update({
      where: { id: logId },
      data: {
        processedAt: this.clock.now(),
        sessionId: result.record?.id ?? null,
        result: `${result.changed ? 'changed' : 'unchanged'}:${result.record?.status ?? 'untracked'}`,
      },
    });
    return {
      eventId: event.eventId,
      type: event.type,
      tracked: result.tracked,
      sessionId: result.record?.id ?? null,
      status: result.record?.status ?? null,
      changed: result.changed,
      duplicate: false,
    };
  }

  /** Drops handled operator webhook ids older than `days` (housekeeping in the payments sweep). */
  async purgeWebhookLogs(days = 30): Promise<number> {
    const before = new Date(this.clock.nowMs() - days * 24 * HOUR_MS);
    const deleted = await this.prisma.parkingWebhookLog.deleteMany({
      where: { receivedAt: { lt: before } },
    });
    return deleted.count;
  }

  /** Re-reads one stored provider session from the operator. Throws when the operator is down. */
  async refresh(record: SessionRecord): Promise<SessionRecord> {
    if (record.source !== 'provider' || !record.providerRef || isFinalStatus(record.status)) {
      return record;
    }
    const snapshot = await this.provider.getSessionByRef(record.providerRef);
    if (!snapshot) {
      return record;
    }
    const result = await this.applySnapshot(snapshot);
    return result.record ?? record;
  }

  /** Asks the operator for the session of an entry talon (nothing is stored here). */
  async findByTalon(talonCode: string): Promise<ProviderSessionSnapshot | null> {
    return this.provider.findSessionByTalon(talonCode);
  }

  /** Asks the operator for the active session of a plate and stores it when tracked. */
  async lookupPlate(plate: string): Promise<SessionRecord | null> {
    const snapshot = await this.provider.findSessionByPlate(plate);
    if (!snapshot) {
      return null;
    }
    const result = await this.applySnapshot(snapshot);
    return result.record;
  }

  /**
   * Stored active provider sessions the operator no longer lists: their final facts are fetched
   * by reference; sessions the operator does not know any more are closed after the TTL.
   */
  async reconcileMissing(
    seenRefs: readonly string[],
    limit = 200,
  ): Promise<{ checked: number; closed: number; failed: number }> {
    const rows = await this.prisma.parkingSession.findMany({
      where: {
        source: 'provider',
        status: { in: ACTIVE_SESSION_STATUSES },
        providerRef: { not: null, notIn: [...seenRefs] },
      },
      orderBy: { lastSyncedAt: 'asc' },
      take: limit,
    });
    const outcome = { checked: rows.length, closed: 0, failed: 0 };
    for (const row of rows) {
      try {
        const snapshot = row.providerRef
          ? await this.provider.getSessionByRef(row.providerRef)
          : null;
        if (snapshot) {
          const result = await this.applySnapshot(snapshot);
          if (result.record && isFinalStatus(result.record.status)) {
            outcome.closed += 1;
          }
        } else if (this.isExpired(row)) {
          await this.closeExpired(row);
          outcome.closed += 1;
        }
      } catch (error) {
        outcome.failed += 1;
        this.logger.warn(
          `parking-sync: session ${row.id} could not be reconciled: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return outcome;
  }

  /** Re-evaluates info-mode timers (status by time, reminders) and closes forgotten ones. */
  async tickInfoTimers(limit = 500): Promise<{ checked: number; changed: number; closed: number }> {
    const rows = await this.prisma.parkingSession.findMany({
      where: { source: 'info_timer', status: { in: ACTIVE_SESSION_STATUSES } },
      orderBy: { enteredAt: 'asc' },
      take: limit,
    });
    const outcome = { checked: rows.length, changed: 0, closed: 0 };
    for (const row of rows) {
      if (this.isExpired(row)) {
        await this.closeExpired(row);
        outcome.closed += 1;
        continue;
      }
      const result = await this.updateFacts(row, {});
      if (result.changed) {
        outcome.changed += 1;
      }
    }
    return outcome;
  }

  // --- local facts (info mode, "I already left", payments) ---------------------------------------

  /** Stores a new info-mode timer. */
  async createInfoTimer(input: {
    userId: string;
    vehicleId: string | null;
    plate: string | null;
    zone: ParkingZone;
    enteredAt: Date;
  }): Promise<SessionRecord> {
    const result = await this.applyFacts({
      previous: null,
      create: { providerRef: null, source: 'info_timer' },
      plate: input.plate,
      zone: input.zone,
      location: NO_LOCATION,
      link: { userId: input.userId, vehicleId: input.vehicleId },
      facts: {
        enteredAt: input.enteredAt,
        exitedAt: null,
        paidUntil: null,
        closedReason: null,
        amountPaidKopecks: 0,
      },
      now: this.clock.now(),
      alert: null,
      paymentId: null,
      publish: this.config.PARKING_INFO_TIMER_EVENTS,
    });
    if (!result.record) {
      throw new Error('Info timer was not stored');
    }
    return result.record;
  }

  /**
   * Applies changed facts to a stored session (exit, paid period, paid amount). Closed sessions
   * are returned unchanged. The patch may be a function of the current row; on a concurrent
   * write the row is re-read and the patch re-applied (up to three attempts), so member actions
   * and payments are never lost to a parallel sync tick.
   */
  async updateFacts(
    record: SessionRecord,
    patch: FactsPatch | ((current: SessionRecord) => FactsPatch),
    options: { paymentId?: string | null } = {},
  ): Promise<ApplyResult> {
    let current = record;
    for (let attempt = 1; ; attempt += 1) {
      if (isFinalStatus(current.status)) {
        return { record: current, tracked: true, changed: false, events: [] };
      }
      const values = typeof patch === 'function' ? patch(current) : patch;
      const result = await this.applyPatch(current, values, options.paymentId ?? null);
      if (!result.conflict || attempt >= MAX_LOCAL_ATTEMPTS) {
        return result;
      }
      const reread = await this.prisma.parkingSession.findUnique({ where: { id: current.id } });
      if (!reread) {
        return result;
      }
      current = reread;
    }
  }

  private async applyPatch(
    record: SessionRecord,
    patch: FactsPatch,
    paymentId: string | null,
  ): Promise<ApplyResult> {
    const exitedAt = patch.exitedAt === undefined ? record.exitedAt : patch.exitedAt;
    const alert = exitedAt ? await this.airRaid.current() : null;
    return this.applyFacts({
      previous: record,
      create: null,
      plate: record.plate,
      zone: patch.zone ?? record.zone,
      location: { level: record.level, spot: record.spot },
      link: { userId: record.userId, vehicleId: record.vehicleId },
      facts: {
        enteredAt: patch.enteredAt ?? record.enteredAt,
        exitedAt,
        paidUntil: patch.paidUntil === undefined ? record.paidUntil : patch.paidUntil,
        closedReason: patch.closedReason === undefined ? record.closedReason : patch.closedReason,
        amountPaidKopecks: patch.amountPaidKopecks ?? record.amountPaidKopecks,
      },
      now: this.clock.now(),
      alert,
      paymentId,
      publish: record.source === 'provider' || this.config.PARKING_INFO_TIMER_EVENTS,
    });
  }

  // --- internals --------------------------------------------------------------------------------

  private isExpired(row: SessionRecord): boolean {
    const ttl = this.config.PARKING_SESSION_TTL_HOURS * HOUR_MS;
    const reference =
      row.source === 'provider' ? (row.lastSyncedAt ?? row.enteredAt) : row.enteredAt;
    return this.clock.nowMs() - reference.getTime() > ttl;
  }

  private async closeExpired(row: SessionRecord): Promise<ApplyResult> {
    return this.updateFacts(row, {
      exitedAt: this.clock.now(),
      closedReason: CLOSE_REASONS.timeout,
    });
  }

  private async resolveOwner(plate: string | null): Promise<Owner> {
    if (!plate) {
      return { tracked: false, userId: null, vehicleId: null };
    }
    const vehicles = await this.prisma.vehicle.findMany({
      where: { plate, deletedAt: null },
      orderBy: [{ verifiedAt: 'desc' }, { createdAt: 'asc' }],
    });
    const verified = vehicles.find((vehicle) => vehicle.verified);
    if (verified) {
      return { tracked: true, userId: verified.userId, vehicleId: verified.id };
    }
    // Unverified owners only get the amount and the paid period (brief section 8), so the
    // session is stored without an owner and looked up by plate.
    return { tracked: vehicles.length > 0, userId: null, vehicleId: null };
  }

  private async applyFacts(input: ApplyInput): Promise<ApplyResult> {
    const { previous, now } = input;
    const { config: tariff } = await this.tariffs.getActiveTariff(now);

    let facts = input.facts;
    if (facts.exitedAt) {
      const atExit = quote(facts.enteredAt, facts.exitedAt, tariff, facts.paidUntil);
      const reason = airRaidCloseReason(
        input.alert,
        facts.exitedAt,
        facts.closedReason,
        atExit.amountDueKopecks,
      );
      if (reason) {
        facts = { ...facts, closedReason: reason };
      }
    }

    const plan = planSession(
      previous
        ? {
            status: previous.status,
            paidUntil: previous.paidUntil,
            exitedAt: previous.exitedAt,
            amountDueKopecks: previous.amountDueKopecks,
            amountPaidKopecks: previous.amountPaidKopecks,
            closedReason: previous.closedReason,
          }
        : null,
      facts,
      now,
      tariff,
    );
    const reminders = isFinalStatus(plan.status)
      ? []
      : dueReminders(
          {
            status: plan.status,
            enteredAt: facts.enteredAt,
            freeUntil: plan.quote.freeUntil,
            paidUntil: plan.paidUntil,
            presenceConfirmedAt: previous?.presenceConfirmedAt ?? null,
          },
          previous?.lastSyncedAt ?? null,
          now,
          this.reminderSettings(),
        );

    const data = {
      userId: input.link.userId,
      vehicleId: input.link.vehicleId,
      plate: input.plate,
      zone: input.zone,
      level: input.location.level,
      spot: input.location.spot,
      enteredAt: facts.enteredAt,
      exitedAt: plan.exitedAt,
      status: plan.status,
      paidUntil: plan.paidUntil,
      amountDueKopecks: plan.amountDueKopecks,
      amountPaidKopecks: plan.amountPaidKopecks,
      closedReason: plan.closedReason,
      lastSyncedAt: now,
    };

    return this.prisma.withTx(async (tx) => {
      let record: SessionRecord;
      if (!previous) {
        record = await tx.parkingSession.create({
          data: {
            id: uuidv7(),
            providerRef: input.create?.providerRef ?? null,
            source: input.create?.source ?? 'provider',
            ...data,
            createdAt: now,
            updatedAt: now,
          },
        });
      } else {
        const updated = await tx.parkingSession.updateMany({
          where: { id: previous.id, status: previous.status, lastSyncedAt: previous.lastSyncedAt },
          data: { ...data, updatedAt: now },
        });
        if (updated.count === 0) {
          // A concurrent writer (webhook, sync tick, refresh) got there first; its step published
          // the events, this one must not repeat them.
          const current = await tx.parkingSession.findUnique({ where: { id: previous.id } });
          return { record: current, tracked: true, changed: false, events: [], conflict: true };
        }
        record = { ...previous, ...data, updatedAt: now };
      }

      // A disputed session («Це не моє авто») is hidden from the member: no events, no reminders.
      const events =
        input.publish && record.userId && !record.disputedAt
          ? [
              ...transitionEvents(
                record,
                plan.events,
                {
                  amountDueKopecks: plan.amountDueKopecks,
                  currentHourEndsAt: plan.quote.currentHourEndsAt,
                  paymentId: input.paymentId,
                },
                now,
              ),
              ...reminders.map((moment) =>
                reminderEvent(record, moment, plan.amountDueKopecks, now),
              ),
            ]
          : [];
      for (const event of events) {
        await this.outbox.publish(tx, event);
      }
      return { record, tracked: true, changed: plan.changed, events: events.map((e) => e.type) };
    });
  }
}
