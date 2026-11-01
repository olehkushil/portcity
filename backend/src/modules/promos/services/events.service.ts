import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import {
  OUTBOX_AGGREGATES,
  PROMO_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import type { EventSummary } from '../../../common/contracts/promos';
import {
  VOUCHER_ISSUER_PORT,
  type VoucherIssuerPort,
  type VoucherSummary,
} from '../../../common/contracts/rewards';
import type { ActorRef } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { PromosErrors } from '../domain/errors';
import {
  type RegistrationDecision,
  canCancelRegistration,
  decideRegistration,
  registrationCancelDeadline,
} from '../domain/event-rules';
import { assertRegistrationTransition } from '../domain/event-state';
import { buildTicketDraft } from '../domain/ticket';
import type {
  EventDto,
  EventListScope,
  ListEventsQueryDto,
  RegistrationDto,
} from '../dto/event.dto';
import { isEventCursor } from './cursors';
import { type RegistrationWithEvent, toEventSummary, toRegistrationDto } from './mappers';
import { PromosPresenter } from './promos-presenter.service';

export interface CancelRegistrationOptions {
  actor: ActorRef;
  reason: string;
  now: Date;
  /** False when the voucher was already cancelled on the rewards side (outbox consumer). */
  cancelVoucher: boolean;
}

export type RegistrationByVoucherOutcome = 'used' | 'cancelled' | 'not_found' | 'already_final';

function registrationRejection(
  decision: Extract<RegistrationDecision, { allowed: false }>,
): DomainError {
  return new DomainError(PromosErrors[decision.code], decision.detail);
}

/**
 * Member-facing events: the poster, the detail with the member's registration, registration
 * with a ticket voucher and cancellation (brief section 8). `registeredCount` counts persons.
 * Poster and detail are guest-readable (`@OptionalAuth()`): without a user `registration` is null.
 * The persons limit is the event's `maxPersonsPerRegistration`, else the `events.registration`
 * flag payload, else 4; events with `admission = external` take no registrations.
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    @Inject(VOUCHER_ISSUER_PORT) private readonly vouchers: VoucherIssuerPort,
    private readonly presenter: PromosPresenter,
  ) {}

  /**
   * Upcoming (published, not ended; soonest first) or past (ended, finished, cancelled),
   * optionally one category. `userId` is undefined for guests (no registrations attached).
   */
  async list(query: ListEventsQueryDto, userId?: string): Promise<Page<EventDto>> {
    const now = this.clock.now();
    const scope: EventListScope = query.scope ?? 'upcoming';
    const cursor = decodeCursor(query.cursor, isEventCursor);
    const conditions: Prisma.EventWhereInput[] = [];
    if (query.category) {
      conditions.push({ category: query.category });
    }
    if (scope === 'upcoming') {
      conditions.push({ status: 'published', endsAt: { gt: now } });
      if (cursor) {
        const startsAt = new Date(cursor.startsAt);
        conditions.push({
          OR: [{ startsAt: { gt: startsAt } }, { startsAt, id: { gt: cursor.id } }],
        });
      }
    } else {
      conditions.push({
        OR: [
          { status: { in: ['finished', 'cancelled'] } },
          { status: 'published', endsAt: { lte: now } },
        ],
      });
      if (cursor) {
        const startsAt = new Date(cursor.startsAt);
        conditions.push({
          OR: [{ startsAt: { lt: startsAt } }, { startsAt, id: { lt: cursor.id } }],
        });
      }
    }
    const direction = scope === 'upcoming' ? 'asc' : 'desc';
    const rows = await this.prisma.event.findMany({
      where: { AND: conditions },
      orderBy: [{ startsAt: direction }, { id: direction }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (last) => ({
      startsAt: last.startsAt.toISOString(),
      id: last.id,
    }));
    const registrations =
      userId && page.items.length > 0
        ? await this.prisma.eventRegistration.findMany({
            where: { userId, eventId: { in: page.items.map((row) => row.id) } },
          })
        : [];
    const byEvent = new Map(registrations.map((row) => [row.eventId, row]));
    return {
      items: await this.presenter.eventDtos(page.items, now, (row) => {
        const registration = byEvent.get(row.id);
        return registration ? toRegistrationDto(registration, row, null, now) : null;
      }),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Any non-draft event with the member's registration and ticket; drafts are 404. Guests
   * (`userId` undefined) get `registration = null`.
   */
  async getForMember(eventId: string, userId?: string): Promise<EventDto> {
    const now = this.clock.now();
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event || event.status === 'draft') {
      throw new DomainError(PromosErrors.PC_EVENT_NOT_FOUND, `Event ${eventId} not found`);
    }
    if (!userId) {
      return this.presenter.eventDto(event, now, null);
    }
    const registration = await this.prisma.eventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });
    const voucher = registration?.voucherId
      ? await this.vouchers.getVoucher(registration.voucherId)
      : null;
    return this.presenter.eventDto(
      event,
      now,
      registration ? toRegistrationDto(registration, event, voucher, now) : null,
    );
  }

  /** Registers the member (one registration per event) and issues the ticket voucher. */
  async register(
    eventId: string,
    userId: string,
    input: { adults: number; children?: number },
  ): Promise<RegistrationDto> {
    const now = this.clock.now();
    const persons = { adults: input.adults, children: input.children ?? 0 };
    const settings = await this.presenter.registrationSettings();
    const context = {
      now,
      registrationEnabled: settings.enabled,
      defaultMaxPersons: settings.defaultMaxPersons,
    };
    const preview = await this.prisma.event.findUnique({ where: { id: eventId } });
    const preliminary = decideRegistration(preview, persons, context);
    if (!preliminary.allowed) {
      throw registrationRejection(preliminary);
    }

    return this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      const event = await tx.event.findUnique({ where: { id: eventId } });
      const decision = decideRegistration(event, persons, context);
      if (!decision.allowed) {
        throw registrationRejection(decision);
      }
      if (!event) {
        throw new DomainError(PromosErrors.PC_EVENT_NOT_FOUND, `Event ${eventId} not found`);
      }

      const existing = await tx.eventRegistration.findUnique({
        where: { eventId_userId: { eventId, userId } },
      });
      if (existing) {
        if (existing.status !== 'cancelled') {
          throw new DomainError(
            PromosErrors.PC_EVENT_ALREADY_REGISTERED,
            existing.status === 'used'
              ? 'The member already checked in for this event'
              : 'The member is already registered for this event',
            { details: { registrationId: existing.id, status: existing.status } },
          );
        }
        // A cancelled registration frees the (event, user) slot: start a fresh one.
        await tx.eventRegistration.delete({ where: { id: existing.id } });
      }

      const registrationId = uuidv7();
      await tx.eventRegistration.create({
        data: {
          id: registrationId,
          eventId,
          userId,
          adults: persons.adults,
          children: persons.children,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      });
      const draft = buildTicketDraft(event, {
        id: registrationId,
        adults: persons.adults,
        children: persons.children,
      });
      const voucher = await this.vouchers.issue(
        {
          userId,
          kind: 'ticket',
          title: draft.title,
          subtitle: draft.subtitle,
          expiresAt: draft.expiresAt,
          sourceType: 'event',
          sourceId: registrationId,
          meta: draft.meta,
        },
        tx,
      );
      const registration = await tx.eventRegistration.update({
        where: { id: registrationId },
        data: { voucherId: voucher.id },
      });
      const updatedEvent = await tx.event.update({
        where: { id: eventId },
        data: { registeredCount: { increment: decision.persons } },
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(
          PROMO_EVENTS.eventRegistered,
          OUTBOX_AGGREGATES.eventRegistration,
          registrationId,
          {
            eventId,
            registrationId,
            userId,
            adults: persons.adults,
            children: persons.children,
            voucherId: voucher.id,
            startsAt: event.startsAt.toISOString(),
            title: event.title,
            venue: event.venue,
          },
        ),
      );
      return toRegistrationDto(registration, updatedEvent, voucher, now);
    });
  }

  /** Member cancellation: allowed until the deadline (domain/event-rules); frees the seats. */
  async cancelRegistration(eventId: string, userId: string): Promise<RegistrationDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      const registration = await tx.eventRegistration.findUnique({
        where: { eventId_userId: { eventId, userId } },
        include: { event: true },
      });
      if (!registration || registration.status !== 'active') {
        throw new DomainError(
          PromosErrors.PC_EVENT_NOT_REGISTERED,
          'The member has no active registration for this event',
        );
      }
      if (!canCancelRegistration(registration.event.startsAt, now)) {
        throw new DomainError(
          PromosErrors.PC_EVENT_CANCEL_DEADLINE_PASSED,
          'The cancellation deadline for this event has passed',
          {
            details: {
              deadline: registrationCancelDeadline(registration.event.startsAt).toISOString(),
            },
          },
        );
      }
      return this.cancelRegistrationRow(tx, registration, {
        actor: { type: 'user', id: userId },
        reason: 'Cancelled by the member',
        now,
        cancelVoucher: true,
      });
    });
  }

  /**
   * Shared cancellation step (member, admin, event cascade, outbox consumer). The caller holds
   * the event row lock and passes the registration loaded inside the same transaction.
   */
  async cancelRegistrationRow(
    tx: Tx,
    registration: RegistrationWithEvent,
    options: CancelRegistrationOptions,
  ): Promise<RegistrationDto> {
    assertRegistrationTransition(registration.status, 'cancelled');
    const updated = await tx.eventRegistration.update({
      where: { id: registration.id },
      data: { status: 'cancelled', cancelledAt: options.now },
    });
    const persons = registration.adults + registration.children;
    const event = await tx.event.update({
      where: { id: registration.eventId },
      data: {
        registeredCount: { decrement: Math.min(persons, registration.event.registeredCount) },
      },
    });
    let voucher: VoucherSummary | null = null;
    if (registration.voucherId) {
      voucher = options.cancelVoucher
        ? await this.cancelTicketVoucher(tx, registration.voucherId, options)
        : await this.vouchers.getVoucher(registration.voucherId);
    }
    await this.outbox.publish(
      tx,
      buildOutboxEvent(
        PROMO_EVENTS.eventRegistrationCancelled,
        OUTBOX_AGGREGATES.eventRegistration,
        registration.id,
        {
          eventId: registration.eventId,
          registrationId: registration.id,
          userId: registration.userId,
          voucherId: registration.voucherId,
        },
      ),
    );
    return toRegistrationDto(updated, event, voucher, options.now);
  }

  /** PromosPort.getEvent. */
  async getEventSummary(eventId: string): Promise<EventSummary | null> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    return event ? toEventSummary(event) : null;
  }

  /** Hourly job: published events whose end has passed become finished. */
  async finishDueEvents(now: Date): Promise<number> {
    const result = await this.prisma.event.updateMany({
      where: { status: 'published', endsAt: { lte: now } },
      data: { status: 'finished', registrationOpen: false },
    });
    return result.count;
  }

  /** Outbox consumer for voucher.redeemed: a redeemed ticket means the member checked in. */
  async markRegistrationUsedByVoucher(voucherId: string): Promise<RegistrationByVoucherOutcome> {
    const registration = await this.prisma.eventRegistration.findUnique({ where: { voucherId } });
    if (!registration) {
      return 'not_found';
    }
    if (registration.status !== 'active') {
      return 'already_final';
    }
    const result = await this.prisma.eventRegistration.updateMany({
      where: { id: registration.id, status: 'active' },
      data: { status: 'used' },
    });
    return result.count === 1 ? 'used' : 'already_final';
  }

  /** Outbox consumer for voucher.cancelled: the ticket was cancelled on the rewards side. */
  async cancelRegistrationByVoucher(
    voucherId: string,
    reason: string,
  ): Promise<RegistrationByVoucherOutcome> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const current = await tx.eventRegistration.findUnique({ where: { voucherId } });
      if (!current) {
        return 'not_found';
      }
      if (current.status !== 'active') {
        return 'already_final';
      }
      await tx.$queryRaw`SELECT id FROM events WHERE id = ${current.eventId}::uuid FOR UPDATE`;
      const registration = await tx.eventRegistration.findUnique({
        where: { id: current.id },
        include: { event: true },
      });
      if (!registration || registration.status !== 'active') {
        return 'already_final';
      }
      await this.cancelRegistrationRow(tx, registration, {
        actor: { type: 'system', id: 'promos-events' },
        reason,
        now,
        cancelVoucher: false,
      });
      return 'cancelled';
    });
  }

  /** Loads an active registration with its event inside a transaction (admin flows). */
  async findRegistration(tx: Tx, registrationId: string): Promise<RegistrationWithEvent | null> {
    return tx.eventRegistration.findUnique({
      where: { id: registrationId },
      include: { event: true },
    });
  }

  private async cancelTicketVoucher(
    tx: Tx,
    voucherId: string,
    options: CancelRegistrationOptions,
  ): Promise<VoucherSummary | null> {
    try {
      return await this.vouchers.cancel(
        { voucherId, reason: options.reason, actor: options.actor, refundPoints: false },
        tx,
      );
    } catch (error) {
      // A ticket that is already redeemed/expired/cancelled stays as it is; the registration
      // is still closed so the seats return to the pool.
      if (
        DomainError.is(error) &&
        (error.code === 'PC_VOUCHER_FINAL' || error.code === 'PC_VOUCHER_NOT_FOUND')
      ) {
        return this.vouchers.getVoucher(voucherId);
      }
      throw error;
    }
  }
}
