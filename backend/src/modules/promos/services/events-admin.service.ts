import { Inject, Injectable } from '@nestjs/common';
import type { Event, Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { CONTENT_PORT, type ContentPort } from '../../../common/contracts/content';
import {
  OUTBOX_AGGREGATES,
  PROMO_EVENTS,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { PromosErrors } from '../domain/errors';
import { isValidAgeRange, isValidCapacityChange, isValidEventWindow } from '../domain/event-rules';
import { assertEventTransition } from '../domain/event-state';
import type {
  AdminListEventsQueryDto,
  AdminListRegistrationsQueryDto,
  CreateEventDto,
  UpdateEventDto,
} from '../dto/admin-event.dto';
import type { EventDto, RegistrationDto } from '../dto/event.dto';
import { isIdCursor } from './cursors';
import { EventsService } from './events.service';
import { toRegistrationDto } from './mappers';
import type { AdminActor } from './promos-admin.service';
import { PromosPresenter } from './promos-presenter.service';

/** Settings validated together on create and on update (merged with the stored row). */
interface EventSettings {
  admission: 'registration' | 'external';
  externalUrl: string | null;
  ageMin: number | null;
  ageMax: number | null;
}

/**
 * Back-office events: CRUD, publish/cancel/finish with the registration cascade, and the
 * registration list with admin cancellation. Audited through ADMIN_AUDIT_PORT. Publishing emits
 * `event.published` (marketing announcement by notifications).
 */
@Injectable()
export class EventsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly events: EventsService,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    private readonly presenter: PromosPresenter,
  ) {}

  async listEvents(query: AdminListEventsQueryDto): Promise<Page<EventDto>> {
    const now = this.clock.now();
    const cursor = decodeCursor(query.cursor, isIdCursor);
    const conditions: Prisma.EventWhereInput[] = [];
    if (query.status) {
      conditions.push({ status: query.status });
    }
    if (query.category) {
      conditions.push({ category: query.category });
    }
    if (query.q) {
      conditions.push({ title: { contains: query.q, mode: 'insensitive' } });
    }
    if (cursor) {
      conditions.push({ id: { lt: cursor.id } });
    }
    const rows = await this.prisma.event.findMany({
      where: { AND: conditions },
      orderBy: [{ id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (last) => ({ id: last.id }));
    return {
      items: await this.presenter.eventDtos(page.items, now),
      nextCursor: page.nextCursor,
    };
  }

  async getEvent(eventId: string): Promise<EventDto> {
    const row = await this.requireEvent(this.prisma, eventId);
    return this.presenter.eventDto(row, this.clock.now());
  }

  async createEvent(input: CreateEventDto, actor: AdminActor): Promise<EventDto> {
    const now = this.clock.now();
    this.assertWindow(input.startsAt, input.endsAt);
    this.assertSettings({
      admission: input.admission ?? 'registration',
      externalUrl: input.externalUrl ?? null,
      ageMin: input.ageMin ?? null,
      ageMax: input.ageMax ?? null,
    });
    await this.assertTenant(input.tenantId ?? null);
    return this.prisma.withTx(async (tx) => {
      const row = await tx.event.create({
        data: {
          id: uuidv7(),
          title: input.title,
          description: input.description ?? null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          venue: input.venue ?? null,
          category: input.category ?? 'other',
          tenantId: input.tenantId ?? null,
          capacity: input.capacity ?? null,
          registeredCount: 0,
          registrationOpen: input.registrationOpen ?? true,
          admission: input.admission ?? 'registration',
          externalUrl: input.externalUrl ?? null,
          maxPersonsPerRegistration: input.maxPersonsPerRegistration ?? null,
          ageLimit: input.ageLimit ?? null,
          ageMin: input.ageMin ?? null,
          ageMax: input.ageMax ?? null,
          imageKey: input.imageKey ?? null,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.auditAs(tx, actor, 'event.create', 'event', row.id, { after: row });
      return this.presenter.eventDto(row, now);
    });
  }

  /**
   * Field updates. Moving the time of a published event with registrations does not rewrite
   * issued tickets (README, open questions): cancel and re-create the event for a real move.
   */
  async updateEvent(eventId: string, input: UpdateEventDto, actor: AdminActor): Promise<EventDto> {
    const now = this.clock.now();
    if (input.tenantId !== undefined) {
      await this.assertTenant(input.tenantId);
    }
    return this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      const before = await this.requireEvent(tx, eventId);
      const startsAt = input.startsAt ?? before.startsAt;
      const endsAt = input.endsAt ?? before.endsAt;
      this.assertWindow(startsAt, endsAt);
      const capacity = input.capacity === undefined ? before.capacity : input.capacity;
      if (!isValidCapacityChange(capacity, before.registeredCount)) {
        throw new DomainError(
          PromosErrors.PC_EVENT_CAPACITY_INVALID,
          `Capacity must be at least the ${before.registeredCount} persons already registered`,
          { details: { registeredCount: before.registeredCount } },
        );
      }
      const settings: EventSettings = {
        admission: input.admission ?? before.admission,
        externalUrl: input.externalUrl === undefined ? before.externalUrl : input.externalUrl,
        ageMin: input.ageMin === undefined ? before.ageMin : input.ageMin,
        ageMax: input.ageMax === undefined ? before.ageMax : input.ageMax,
      };
      this.assertSettings(settings);
      if (
        settings.admission === 'external' &&
        before.admission !== 'external' &&
        before.registeredCount > 0
      ) {
        throw new DomainError(
          PromosErrors.PC_EVENT_ADMISSION_INVALID,
          'The event has registered persons; cancel their registrations before switching to external admission',
          { details: { registeredCount: before.registeredCount } },
        );
      }
      const row = await tx.event.update({
        where: { id: eventId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.venue !== undefined ? { venue: input.venue } : {}),
          ...(input.registrationOpen !== undefined
            ? { registrationOpen: input.registrationOpen }
            : {}),
          ...(input.ageLimit !== undefined ? { ageLimit: input.ageLimit } : {}),
          ...(input.imageKey !== undefined ? { imageKey: input.imageKey } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
          ...(input.maxPersonsPerRegistration !== undefined
            ? { maxPersonsPerRegistration: input.maxPersonsPerRegistration }
            : {}),
          admission: settings.admission,
          externalUrl: settings.externalUrl,
          ageMin: settings.ageMin,
          ageMax: settings.ageMax,
          startsAt,
          endsAt,
          capacity,
          updatedAt: now,
        },
      });
      await this.auditAs(tx, actor, 'event.update', 'event', row.id, { before, after: row });
      return this.presenter.eventDto(row, now);
    });
  }

  async publishEvent(eventId: string, actor: AdminActor, reason?: string): Promise<EventDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const before = await this.requireEvent(tx, eventId);
      assertEventTransition(before.status, 'published');
      if (before.endsAt.getTime() <= now.getTime()) {
        throw new DomainError(
          PromosErrors.PC_EVENT_DATES_INVALID,
          'The event already ended; move it before publishing',
        );
      }
      const row = await tx.event.update({
        where: { id: eventId },
        data: { status: 'published', updatedAt: now },
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(PROMO_EVENTS.eventPublished, OUTBOX_AGGREGATES.event, row.id, {
          eventId: row.id,
          title: row.title,
          category: row.category,
          tenantId: row.tenantId,
          venue: row.venue,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          admission: row.admission,
        }),
      );
      await this.auditAs(tx, actor, 'event.publish', 'event', row.id, {
        before: { status: before.status },
        after: { status: row.status },
        reason,
      });
      return this.presenter.eventDto(row, now);
    });
  }

  /**
   * Cancels the event and cascades: every active registration is cancelled, its ticket voucher
   * is cancelled through the rewards port and `event.cancelled` carries the affected members.
   */
  async cancelEvent(eventId: string, reason: string, actor: AdminActor): Promise<EventDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      const before = await this.requireEvent(tx, eventId);
      assertEventTransition(before.status, 'cancelled');
      const active = await tx.eventRegistration.findMany({
        where: { eventId, status: 'active' },
        include: { event: true },
        orderBy: [{ id: 'asc' }],
      });
      const registeredUserIds: string[] = [];
      for (const registration of active) {
        await this.events.cancelRegistrationRow(tx, registration, {
          actor: { type: 'admin', id: actor.id },
          reason: `Event cancelled: ${reason}`,
          now,
          cancelVoucher: true,
        });
        registeredUserIds.push(registration.userId);
      }
      const row = await tx.event.update({
        where: { id: eventId },
        data: { status: 'cancelled', registrationOpen: false, registeredCount: 0, updatedAt: now },
      });
      await this.outbox.publish(
        tx,
        buildOutboxEvent(PROMO_EVENTS.eventCancelled, OUTBOX_AGGREGATES.event, row.id, {
          eventId: row.id,
          title: row.title,
          registeredUserIds,
        }),
      );
      await this.auditAs(tx, actor, 'event.cancel', 'event', row.id, {
        before: { status: before.status, registeredCount: before.registeredCount },
        after: { status: row.status, cancelledRegistrations: active.length },
        reason,
      });
      return this.presenter.eventDto(row, now);
    });
  }

  async finishEvent(eventId: string, actor: AdminActor, reason?: string): Promise<EventDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const before = await this.requireEvent(tx, eventId);
      assertEventTransition(before.status, 'finished');
      const row = await tx.event.update({
        where: { id: eventId },
        data: { status: 'finished', registrationOpen: false, updatedAt: now },
      });
      await this.auditAs(tx, actor, 'event.finish', 'event', row.id, {
        before: { status: before.status },
        after: { status: row.status },
        reason,
      });
      return this.presenter.eventDto(row, now);
    });
  }

  /** Only drafts (no registrations possible) can be deleted. */
  async deleteEvent(eventId: string, actor: AdminActor, reason?: string): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      const before = await this.requireEvent(tx, eventId);
      if (before.status !== 'draft') {
        throw new DomainError(
          PromosErrors.PC_EVENT_NOT_DRAFT,
          `Event is ${before.status}; cancel or finish it instead of deleting`,
        );
      }
      await tx.event.delete({ where: { id: eventId } });
      await this.auditAs(tx, actor, 'event.delete', 'event', eventId, {
        before,
        after: null,
        reason,
      });
    });
  }

  async listRegistrations(
    eventId: string,
    query: AdminListRegistrationsQueryDto,
  ): Promise<Page<RegistrationDto>> {
    const now = this.clock.now();
    const event = await this.requireEvent(this.prisma, eventId);
    const cursor = decodeCursor(query.cursor, isIdCursor);
    const conditions: Prisma.EventRegistrationWhereInput[] = [{ eventId }];
    if (query.status) {
      conditions.push({ status: query.status });
    }
    if (cursor) {
      conditions.push({ id: { lt: cursor.id } });
    }
    const rows = await this.prisma.eventRegistration.findMany({
      where: { AND: conditions },
      orderBy: [{ id: 'desc' }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (last) => ({ id: last.id }));
    return {
      items: page.items.map((row) => toRegistrationDto(row, event, null, now)),
      nextCursor: page.nextCursor,
    };
  }

  /** Admin cancellation ignores the member deadline; the ticket is cancelled, seats return. */
  async cancelRegistration(
    eventId: string,
    registrationId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<RegistrationDto> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      const registration = await this.events.findRegistration(tx, registrationId);
      if (!registration || registration.eventId !== eventId) {
        throw new DomainError(
          PromosErrors.PC_EVENT_REGISTRATION_NOT_FOUND,
          `Registration ${registrationId} not found for event ${eventId}`,
        );
      }
      const result = await this.events.cancelRegistrationRow(tx, registration, {
        actor: { type: 'admin', id: actor.id },
        reason,
        now,
        cancelVoucher: true,
      });
      await this.auditAs(
        tx,
        actor,
        'event_registration.cancel',
        'event_registration',
        registration.id,
        {
          before: { status: registration.status },
          after: { status: result.status },
          reason,
        },
      );
      return result;
    });
  }

  private async requireEvent(db: Tx | PrismaService, eventId: string): Promise<Event> {
    const row = await db.event.findUnique({ where: { id: eventId } });
    if (!row) {
      throw new DomainError(PromosErrors.PC_EVENT_NOT_FOUND, `Event ${eventId} not found`);
    }
    return row;
  }

  private assertWindow(startsAt: Date, endsAt: Date): void {
    if (!isValidEventWindow(startsAt, endsAt)) {
      throw new DomainError(PromosErrors.PC_EVENT_DATES_INVALID, 'startsAt must be before endsAt');
    }
  }

  private assertSettings(settings: EventSettings): void {
    if (!isValidAgeRange(settings.ageMin, settings.ageMax)) {
      throw new DomainError(
        PromosErrors.PC_EVENT_AGE_RANGE_INVALID,
        'ageMin must not be greater than ageMax (both 0-99)',
        { details: { ageMin: settings.ageMin, ageMax: settings.ageMax } },
      );
    }
    if (settings.admission === 'external' && !settings.externalUrl) {
      throw new DomainError(
        PromosErrors.PC_EVENT_ADMISSION_INVALID,
        'An event with external admission needs externalUrl',
      );
    }
  }

  private async assertTenant(tenantId: string | null): Promise<void> {
    if (!tenantId) {
      return;
    }
    const tenant = await this.content.getTenant(tenantId);
    if (!tenant) {
      throw new DomainError(
        PromosErrors.PC_EVENT_TENANT_NOT_FOUND,
        `Tenant ${tenantId} does not exist`,
      );
    }
  }

  /** Audit row in the caller's transaction, so it commits or rolls back with the change. */
  private async auditAs(
    tx: Tx,
    actor: AdminActor,
    action: string,
    entityType: string,
    entityId: string,
    snapshot: { before?: unknown; after?: unknown; reason?: string },
  ): Promise<void> {
    await this.audit.audit(
      {
        actor: { type: 'admin', id: actor.id },
        action,
        entityType,
        entityId,
        before: snapshot.before,
        after: snapshot.after,
        reason: snapshot.reason ?? null,
        ip: actor.ip ?? null,
      },
      tx,
    );
  }
}
