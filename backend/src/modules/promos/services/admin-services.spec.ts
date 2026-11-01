import type { CouponTemplate, Event, EventRegistration, Promo } from '@prisma/client';
import type { AdminAuditPort, AuditEntry, FeatureFlagsPort } from '../../../common/contracts/admin';
import type { ContentPort, TenantSummary } from '../../../common/contracts/content';
import type { OutboxEventInput } from '../../../common/outbox/outbox.types';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { EventsAdminService } from './events-admin.service';
import type { EventsService } from './events.service';
import { PromosAdminService } from './promos-admin.service';
import { PromosPresenter } from './promos-presenter.service';

const NOW = '2026-11-01T10:00:00.000Z';
const TENANT_ID = '01900000-0000-7000-8000-0000000000f1';

const FIGLI_MIGLI: TenantSummary = {
  id: TENANT_ID,
  slug: 'figli-migli',
  name: 'Figli Migli',
  category: 'kids',
  floor: 3,
  logoKey: null,
  participates: true,
  ratePercentOverride: null,
  excludedFromProgram: false,
  status: 'active',
};

function fakeContent(tenants: TenantSummary[] = []) {
  return {
    getTenant: jest.fn(async (id: string) => tenants.find((tenant) => tenant.id === id) ?? null),
    getTenants: jest.fn(async (ids: string[]) =>
      tenants.filter((tenant) => ids.includes(tenant.id)),
    ),
  };
}

function presenterWith(content: ReturnType<typeof fakeContent>): PromosPresenter {
  const flags: FeatureFlagsPort = {
    isEnabled: jest.fn(async () => true),
    get: jest.fn(async () => null),
  };
  return new PromosPresenter(
    { S3_PUBLIC_BASE_URL: 'https://cdn.portcity.test' },
    content as unknown as ContentPort,
    flags,
  );
}
const ACTOR = { id: '01900000-0000-7000-8000-0000000000c2', ip: '10.0.0.2' };

function auditSpy(): { port: AdminAuditPort; entries: Array<{ entry: AuditEntry; tx: unknown }> } {
  const entries: Array<{ entry: AuditEntry; tx: unknown }> = [];
  return {
    entries,
    port: {
      audit: jest.fn(async (entry: AuditEntry, tx?: unknown) => {
        entries.push({ entry, tx });
        return 'audit';
      }),
    },
  };
}

function outboxSpy(): { service: OutboxService; events: OutboxEventInput[] } {
  const events: OutboxEventInput[] = [];
  const service = {
    publish: jest.fn(async (_tx: unknown, event: OutboxEventInput) => {
      events.push(event);
      return 'evt';
    }),
  } as unknown as OutboxService;
  return { service, events };
}

function promoRow(
  overrides: Partial<Promo> = {},
): Promo & { couponTemplate: CouponTemplate | null } {
  return {
    id: 'promo-1',
    tenantId: null,
    title: '1+1 Aroma Kava',
    body: 'Друга кава в подарунок',
    kind: 'info',
    category: 'food',
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    validTo: new Date('2026-11-30T00:00:00.000Z'),
    imageKey: null,
    status: 'draft',
    couponTemplateId: null,
    priority: 0,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    couponTemplate: null,
    ...overrides,
  };
}

function promosSetup() {
  const tx = {
    promo: {
      findUnique: jest.fn(),
      create: jest.fn(async (args: { data: Promo }) => ({ ...args.data, couponTemplate: null })),
      update: jest.fn(async (args: { where: { id: string }; data: Partial<Promo> }) =>
        promoRow({ id: args.where.id, ...args.data }),
      ),
      delete: jest.fn(),
    },
    couponTemplate: {
      create: jest.fn(async (args: { data: CouponTemplate }) => args.data),
      findUnique: jest.fn(),
    },
  };
  const prisma = { ...tx, withTx: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
  const audit = auditSpy();
  const outbox = outboxSpy();
  const content = fakeContent();
  const service = new PromosAdminService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW),
    outbox.service,
    content as unknown as ContentPort,
    audit.port,
    presenterWith(content),
  );
  return { service, tx, audit, outbox, content };
}

describe('PromosAdminService', () => {
  it('creates a coupon promo with an inline template, auditing both rows in the transaction', async () => {
    const { service, tx, audit } = promosSetup();

    const dto = await service.createPromo(
      {
        title: '-20 % INTERTOP',
        body: 'Знижка',
        kind: 'coupon',
        validFrom: new Date('2026-11-01T00:00:00.000Z'),
        validTo: new Date('2026-11-15T00:00:00.000Z'),
        couponTemplate: { discountText: '-20 %', perUserLimit: 1, totalLimit: 50 },
      },
      ACTOR,
    );

    expect(dto).toMatchObject({ status: 'draft', kind: 'coupon' });
    expect(tx.couponTemplate.create).toHaveBeenCalledTimes(1);
    expect(audit.entries.map(({ entry }) => entry.action)).toEqual([
      'coupon_template.create',
      'promo.create',
    ]);
    expect(audit.entries.every(({ tx: client }) => client === tx)).toBe(true);
    expect(audit.entries[1]?.entry).toMatchObject({
      actor: { type: 'admin', id: ACTOR.id },
      ip: '10.0.0.2',
    });
  });

  it.each([
    [{ kind: 'coupon' as const }, 'PC_PROMO_TEMPLATE_REQUIRED'],
    [{ kind: 'info' as const, couponTemplate: { discountText: '-10 %' } }, 'PC_PROMO_NOT_COUPON'],
    [
      {
        validFrom: new Date('2026-11-20T00:00:00.000Z'),
        validTo: new Date('2026-11-10T00:00:00.000Z'),
      },
      'PC_PROMO_DATES_INVALID',
    ],
    [{ tenantId: '01900000-0000-7000-8000-0000000000ff' }, 'PC_PROMO_TENANT_NOT_FOUND'],
  ])('rejects create input %j with %s', async (override, code) => {
    const { service, tx } = promosSetup();
    await expect(
      service.createPromo(
        {
          title: 'Акція',
          body: 'Текст',
          validFrom: new Date('2026-11-01T00:00:00.000Z'),
          validTo: new Date('2026-11-15T00:00:00.000Z'),
          ...override,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code });
    expect(tx.promo.create).not.toHaveBeenCalled();
  });

  it('publishes a draft, emits promo.published and audits in the transaction', async () => {
    const { service, tx, audit, outbox } = promosSetup();
    tx.promo.findUnique.mockResolvedValueOnce(promoRow());

    const dto = await service.publishPromo('promo-1', ACTOR, 'Погоджено');

    expect(dto.status).toBe('published');
    expect(outbox.events).toEqual([
      expect.objectContaining({
        type: 'promo.published',
        payload: expect.objectContaining({ promoId: 'promo-1', kind: 'info' }),
      }),
    ]);
    expect(audit.entries).toEqual([
      {
        entry: expect.objectContaining({ action: 'promo.publish', reason: 'Погоджено' }),
        tx,
      },
    ]);
  });

  it('refuses to publish an archived promo or one whose window has passed', async () => {
    const { service, tx } = promosSetup();
    tx.promo.findUnique.mockResolvedValueOnce(promoRow({ status: 'archived' }));
    await expect(service.publishPromo('promo-1', ACTOR)).rejects.toMatchObject({
      code: 'PC_PROMO_INVALID_TRANSITION',
    });
    tx.promo.findUnique.mockResolvedValueOnce(
      promoRow({ validTo: new Date('2026-10-01T00:00:00.000Z') }),
    );
    await expect(service.publishPromo('promo-1', ACTOR)).rejects.toMatchObject({
      code: 'PC_PROMO_DATES_INVALID',
    });
  });

  it('deletes drafts only', async () => {
    const { service, tx, audit } = promosSetup();
    tx.promo.findUnique.mockResolvedValueOnce(promoRow({ status: 'published' }));
    await expect(service.deletePromo('promo-1', ACTOR)).rejects.toMatchObject({
      code: 'PC_PROMO_NOT_DRAFT',
      status: 409,
    });
    tx.promo.findUnique.mockResolvedValueOnce(promoRow());
    await service.deletePromo('promo-1', ACTOR, 'Помилка');
    expect(tx.promo.delete).toHaveBeenCalledWith({ where: { id: 'promo-1' } });
    expect(audit.entries.at(-1)?.entry).toMatchObject({ action: 'promo.delete', after: null });
  });
});

function eventRow(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    title: 'Майстер-клас для дітей',
    description: null,
    startsAt: new Date('2026-11-07T13:00:00.000Z'),
    endsAt: new Date('2026-11-07T14:30:00.000Z'),
    venue: null,
    category: 'kids',
    tenantId: null,
    capacity: 30,
    registeredCount: 3,
    registrationOpen: true,
    admission: 'registration',
    externalUrl: null,
    maxPersonsPerRegistration: null,
    ageLimit: null,
    ageMin: null,
    ageMax: null,
    imageKey: null,
    status: 'published',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

function registration(id: string, userId: string): EventRegistration & { event: Event } {
  return {
    id,
    eventId: 'event-1',
    userId,
    adults: 1,
    children: 0,
    voucherId: `ticket-${id}`,
    status: 'active',
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    cancelledAt: null,
    event: eventRow(),
  };
}

describe('EventsAdminService.cancelEvent', () => {
  it('cascades to active registrations and lists the affected members in event.cancelled', async () => {
    const regs = [registration('r1', 'user-1'), registration('r2', 'user-2')];
    const tx = {
      $queryRaw: jest.fn(async () => []),
      event: {
        findUnique: jest.fn(async () => eventRow()),
        update: jest.fn(async (args: { data: Partial<Event> }) => eventRow(args.data)),
      },
      eventRegistration: { findMany: jest.fn(async () => regs) },
    };
    const prisma = { withTx: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
    const events = { cancelRegistrationRow: jest.fn(async () => ({})) };
    const audit = auditSpy();
    const outbox = outboxSpy();
    const content = fakeContent();
    const service = new EventsAdminService(
      prisma as unknown as PrismaService,
      new FakeClock(NOW),
      outbox.service,
      events as unknown as EventsService,
      audit.port,
      content as unknown as ContentPort,
      presenterWith(content),
    );

    const dto = await service.cancelEvent('event-1', 'Хвороба ведучого', ACTOR);

    expect(dto).toMatchObject({ status: 'cancelled', registrationOpen: false, registeredCount: 0 });
    expect(events.cancelRegistrationRow).toHaveBeenCalledTimes(2);
    expect(events.cancelRegistrationRow).toHaveBeenCalledWith(tx, regs[0], {
      actor: { type: 'admin', id: ACTOR.id },
      reason: 'Event cancelled: Хвороба ведучого',
      now: new Date(NOW),
      cancelVoucher: true,
    });
    expect(outbox.events).toEqual([
      expect.objectContaining({
        type: 'event.cancelled',
        payload: {
          eventId: 'event-1',
          title: 'Майстер-клас для дітей',
          registeredUserIds: ['user-1', 'user-2'],
        },
      }),
    ]);
    expect(audit.entries).toEqual([
      {
        entry: expect.objectContaining({
          action: 'event.cancel',
          reason: 'Хвороба ведучого',
          after: { status: 'cancelled', cancelledRegistrations: 2 },
        }),
        tx,
      },
    ]);
  });

  it('refuses to cancel a finished event', async () => {
    const tx = {
      $queryRaw: jest.fn(async () => []),
      event: {
        findUnique: jest.fn(async () => eventRow({ status: 'finished' })),
        update: jest.fn(),
      },
      eventRegistration: { findMany: jest.fn() },
    };
    const prisma = { withTx: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
    const content = fakeContent();
    const service = new EventsAdminService(
      prisma as unknown as PrismaService,
      new FakeClock(NOW),
      outboxSpy().service,
      { cancelRegistrationRow: jest.fn() } as unknown as EventsService,
      auditSpy().port,
      content as unknown as ContentPort,
      presenterWith(content),
    );
    await expect(service.cancelEvent('event-1', 'Причина', ACTOR)).rejects.toMatchObject({
      code: 'PC_EVENT_INVALID_TRANSITION',
    });
    expect(tx.event.update).not.toHaveBeenCalled();
  });
});

function eventsAdminSetup(initial: Event = eventRow({ status: 'draft' })) {
  let stored: Event = initial;
  const tx = {
    $queryRaw: jest.fn(async () => []),
    event: {
      findUnique: jest.fn(async () => stored),
      findMany: jest.fn(async () => [stored]),
      create: jest.fn(async (args: { data: Event }) => {
        stored = args.data;
        return stored;
      }),
      update: jest.fn(async (args: { data: Partial<Event> }) => {
        stored = { ...stored, ...args.data };
        return stored;
      }),
    },
    eventRegistration: { findMany: jest.fn(async () => []) },
  };
  const prisma = { ...tx, withTx: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) };
  const audit = auditSpy();
  const outbox = outboxSpy();
  const content = fakeContent([FIGLI_MIGLI]);
  const service = new EventsAdminService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW),
    outbox.service,
    { cancelRegistrationRow: jest.fn() } as unknown as EventsService,
    audit.port,
    content as unknown as ContentPort,
    presenterWith(content),
  );
  return { service, tx, audit, outbox };
}

const NEW_EVENT = {
  title: 'Майстер-клас «Розпис пряників»',
  startsAt: new Date('2026-11-07T10:00:00.000Z'),
  endsAt: new Date('2026-11-07T11:30:00.000Z'),
};

describe('EventsAdminService event fields', () => {
  it('stores category, host tenant, admission, age range and the persons limit', async () => {
    const { service, tx } = eventsAdminSetup();
    const dto = await service.createEvent(
      {
        ...NEW_EVENT,
        category: 'masterclass',
        tenantId: TENANT_ID,
        ageMin: 5,
        ageMax: 10,
        maxPersonsPerRegistration: 3,
        imageKey: 'events/2026/11/pryaniky.jpg',
      },
      ACTOR,
    );
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        category: 'masterclass',
        tenantId: TENANT_ID,
        admission: 'registration',
        externalUrl: null,
        ageMin: 5,
        ageMax: 10,
        maxPersonsPerRegistration: 3,
      }),
    });
    expect(dto).toMatchObject({
      category: 'masterclass',
      tenantId: TENANT_ID,
      tenant: { id: TENANT_ID, name: 'Figli Migli', floor: 3 },
      maxPersonsPerRegistration: 3,
      ageMin: 5,
      ageMax: 10,
      imageUrl: 'https://cdn.portcity.test/events/2026/11/pryaniky.jpg',
      // 12:00 Kyiv is after 11:00, so the deadline is 11:00 Kyiv = 09:00 UTC.
      cancelDeadline: new Date('2026-11-07T09:00:00.000Z'),
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['reversed age range', { ageMin: 12, ageMax: 6 }, 'PC_EVENT_AGE_RANGE_INVALID'],
    ['external admission without a link', { admission: 'external' }, 'PC_EVENT_ADMISSION_INVALID'],
    [
      'unknown host tenant',
      { tenantId: '01900000-0000-7000-8000-0000000000ff' },
      'PC_EVENT_TENANT_NOT_FOUND',
    ],
  ])('refuses %s', async (_name, extra, code) => {
    const { service, tx } = eventsAdminSetup();
    await expect(service.createEvent({ ...NEW_EVENT, ...extra }, ACTOR)).rejects.toMatchObject({
      code,
    });
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it('has no cancel deadline and no registration for external admission', async () => {
    const { service } = eventsAdminSetup();
    const dto = await service.createEvent(
      {
        ...NEW_EVENT,
        category: 'cinema',
        admission: 'external',
        externalUrl: 'https://premiercity.com.ua/afisha',
      },
      ACTOR,
    );
    expect(dto).toMatchObject({
      admission: 'external',
      externalUrl: 'https://premiercity.com.ua/afisha',
      cancelDeadline: null,
      canRegister: false,
    });
  });

  it('refuses to switch an event with registrations to external admission', async () => {
    const { service } = eventsAdminSetup(eventRow({ registeredCount: 2 }));
    await expect(
      service.updateEvent(
        'event-1',
        { admission: 'external', externalUrl: 'https://example.com/tickets' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'PC_EVENT_ADMISSION_INVALID' });
  });

  it('publishes event.published with the facts notifications announce', async () => {
    const { service, outbox } = eventsAdminSetup(
      eventRow({ status: 'draft', tenantId: TENANT_ID, venue: 'Figli Migli, 3 поверх' }),
    );
    const dto = await service.publishEvent('event-1', ACTOR);
    expect(dto.status).toBe('published');
    expect(outbox.events).toEqual([
      expect.objectContaining({
        type: 'event.published',
        aggregateType: 'event',
        aggregateId: 'event-1',
        payload: {
          eventId: 'event-1',
          title: 'Майстер-клас для дітей',
          category: 'kids',
          tenantId: TENANT_ID,
          venue: 'Figli Migli, 3 поверх',
          startsAt: '2026-11-07T13:00:00.000Z',
          endsAt: '2026-11-07T14:30:00.000Z',
          admission: 'registration',
        },
      }),
    ]);
  });

  it('filters the back-office list by category', async () => {
    const { service, tx } = eventsAdminSetup();
    await service.listEvents({ limit: 20, category: 'kids' });
    expect(tx.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { AND: [{ category: 'kids' }] } }),
    );
  });
});

describe('PromosAdminService categories', () => {
  it('stores the category and filters the list by it', async () => {
    const { service, tx } = promosSetup();
    const dto = await service.createPromo(
      {
        title: '-20 % INTERTOP',
        body: 'Знижка',
        category: 'fashion',
        validFrom: new Date('2026-11-01T00:00:00.000Z'),
        validTo: new Date('2026-11-15T00:00:00.000Z'),
        imageKey: 'promos/intertop.jpg',
      },
      ACTOR,
    );
    expect(tx.promo.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ category: 'fashion' }) }),
    );
    expect(dto).toMatchObject({
      category: 'fashion',
      imageUrl: 'https://cdn.portcity.test/promos/intertop.jpg',
    });
  });
});
