import type { Event, EventRegistration } from '@prisma/client';
import type { FeatureFlagView, FeatureFlagsPort } from '../../../common/contracts/admin';
import type { ContentPort } from '../../../common/contracts/content';
import type {
  CancelVoucherInput,
  IssueVoucherInput,
  VoucherIssuerPort,
  VoucherSummary,
} from '../../../common/contracts/rewards';
import { DomainError } from '../../../common/errors/domain-error';
import type { OutboxEventInput } from '../../../common/outbox/outbox.types';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { EventsService } from './events.service';
import { PromosPresenter } from './promos-presenter.service';

const NOW = '2026-11-01T10:00:00.000Z';
const USER = '01900000-0000-7000-8000-000000000001';
const EVENT = '01900000-0000-7000-8000-0000000000e1';

function eventRow(overrides: Partial<Event> = {}): Event {
  return {
    id: EVENT,
    title: 'Майстер-клас для дітей',
    description: 'Ліпимо з глини',
    // Saturday 15:00 Kyiv (UTC+2 in November).
    startsAt: new Date('2026-11-07T13:00:00.000Z'),
    endsAt: new Date('2026-11-07T14:30:00.000Z'),
    venue: 'Атріум, 1 поверх',
    category: 'kids',
    tenantId: null,
    capacity: 30,
    registeredCount: 0,
    registrationOpen: true,
    admission: 'registration',
    externalUrl: null,
    maxPersonsPerRegistration: null,
    ageLimit: 6,
    ageMin: 6,
    ageMax: 12,
    imageKey: null,
    status: 'published',
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    ...overrides,
  };
}

type RegistrationWhere = {
  id?: string;
  voucherId?: string;
  eventId_userId?: { eventId: string; userId: string };
};

class FakePrisma {
  events = new Map<string, Event>();
  registrations: EventRegistration[] = [];

  private findRegistration(where: RegistrationWhere): EventRegistration | undefined {
    return this.registrations.find((row) => {
      if (where.id !== undefined) {
        return row.id === where.id;
      }
      if (where.voucherId !== undefined) {
        return row.voucherId === where.voucherId;
      }
      if (where.eventId_userId) {
        return (
          row.eventId === where.eventId_userId.eventId && row.userId === where.eventId_userId.userId
        );
      }
      return false;
    });
  }

  readonly event = {
    findUnique: async (args: { where: { id: string } }) => {
      const row = this.events.get(args.where.id);
      return row ? { ...row } : null;
    },
    findMany: jest.fn(async (args: { take: number }) =>
      [...this.events.values()].slice(0, args.take).map((row) => ({ ...row })),
    ),
    update: async (args: {
      where: { id: string };
      data: { registeredCount: { increment?: number; decrement?: number } };
    }) => {
      const row = this.events.get(args.where.id);
      if (!row) {
        throw new Error('event missing');
      }
      const change = args.data.registeredCount;
      row.registeredCount += (change.increment ?? 0) - (change.decrement ?? 0);
      return { ...row };
    },
    updateMany: async (args: { where: { status: string; endsAt: { lte: Date } } }) => {
      let count = 0;
      for (const row of this.events.values()) {
        if (
          row.status === args.where.status &&
          row.endsAt.getTime() <= args.where.endsAt.lte.getTime()
        ) {
          row.status = 'finished';
          row.registrationOpen = false;
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly eventRegistration = {
    findUnique: async (args: { where: RegistrationWhere; include?: { event: true } }) => {
      const row = this.findRegistration(args.where);
      if (!row) {
        return null;
      }
      return args.include ? { ...row, event: this.events.get(row.eventId) } : { ...row };
    },
    findMany: jest.fn(async (args: { where: { userId: string; eventId: { in: string[] } } }) =>
      this.registrations.filter(
        (row) => row.userId === args.where.userId && args.where.eventId.in.includes(row.eventId),
      ),
    ),
    create: async (args: { data: Omit<EventRegistration, 'voucherId' | 'cancelledAt'> }) => {
      const row: EventRegistration = { voucherId: null, cancelledAt: null, ...args.data };
      this.registrations.push(row);
      return { ...row };
    },
    delete: async (args: { where: { id: string } }) => {
      this.registrations = this.registrations.filter((row) => row.id !== args.where.id);
    },
    update: async (args: { where: { id: string }; data: Partial<EventRegistration> }) => {
      const row = this.findRegistration({ id: args.where.id });
      if (!row) {
        throw new Error('registration missing');
      }
      Object.assign(row, args.data);
      return { ...row };
    },
    updateMany: async (args: {
      where: { id: string; status: string };
      data: Partial<EventRegistration>;
    }) => {
      const row = this.findRegistration({ id: args.where.id });
      if (!row || row.status !== args.where.status) {
        return { count: 0 };
      }
      Object.assign(row, args.data);
      return { count: 1 };
    },
  };

  readonly $queryRaw = jest.fn(async () => []);

  withTx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakeVoucherIssuer implements VoucherIssuerPort {
  readonly vouchers: VoucherSummary[] = [];

  issue = jest.fn(async (input: IssueVoucherInput, _tx?: unknown): Promise<VoucherSummary> => {
    const voucher: VoucherSummary = {
      id: `ticket-${this.vouchers.length + 1}`,
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      subtitle: input.subtitle ?? null,
      tenantId: input.tenantId ?? null,
      status: 'issued',
      code: null,
      activatedAt: null,
      activationExpiresAt: null,
      redeemedAt: null,
      redeemedByTenantId: null,
      expiresAt: input.expiresAt ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      meta: input.meta ?? {},
      createdAt: new Date(NOW),
    };
    this.vouchers.push(voucher);
    return voucher;
  });

  cancel = jest.fn(async (input: CancelVoucherInput): Promise<VoucherSummary> => {
    const voucher = this.vouchers.find((entry) => entry.id === input.voucherId);
    if (!voucher) {
      throw new DomainError('PC_VOUCHER_NOT_FOUND', 'missing', { status: 404 });
    }
    if (voucher.status !== 'issued' && voucher.status !== 'active') {
      throw new DomainError('PC_VOUCHER_FINAL', 'final', { status: 409 });
    }
    voucher.status = 'cancelled';
    return voucher;
  });

  getVoucher = jest.fn(
    async (id: string) => this.vouchers.find((entry) => entry.id === id) ?? null,
  );
  listBySource = jest.fn(async () => []);
  getDailyStats = jest.fn();
}

function setup(
  options: {
    event?: Partial<Event>;
    registrationEnabled?: boolean;
    flagPayload?: Record<string, unknown> | null;
  } = {},
) {
  const prisma = new FakePrisma();
  prisma.events.set(EVENT, eventRow(options.event));
  const clock = new FakeClock(NOW);
  const vouchers = new FakeVoucherIssuer();
  const events: OutboxEventInput[] = [];
  const outbox = {
    publish: jest.fn(async (_tx: unknown, event: OutboxEventInput) => {
      events.push(event);
      return 'evt';
    }),
  };
  const flag: FeatureFlagView | null =
    options.registrationEnabled === undefined && options.flagPayload === undefined
      ? null
      : {
          key: 'events.registration',
          enabled: options.registrationEnabled ?? true,
          payload: options.flagPayload ?? null,
          updatedAt: new Date(NOW),
        };
  const flags: FeatureFlagsPort = {
    isEnabled: jest.fn(async () => options.registrationEnabled ?? true),
    get: jest.fn(async () => flag),
  };
  const content = { getTenant: jest.fn(async () => null), getTenants: jest.fn(async () => []) };
  const presenter = new PromosPresenter(
    { S3_PUBLIC_BASE_URL: undefined },
    content as unknown as ContentPort,
    flags,
  );
  const service = new EventsService(
    prisma as unknown as PrismaService,
    clock,
    outbox as unknown as OutboxService,
    vouchers,
    presenter,
  );
  return { service, prisma, vouchers, events, clock, flags };
}

describe('EventsService.register', () => {
  it('registers the member and issues the ticket through VOUCHER_ISSUER_PORT', async () => {
    const { service, prisma, vouchers, events, flags } = setup();

    const registration = await service.register(EVENT, USER, { adults: 1, children: 2 });

    expect(flags.get).toHaveBeenCalledWith('events.registration');
    expect(vouchers.issue).toHaveBeenCalledTimes(1);
    const [input, tx] = vouchers.issue.mock.calls[0] ?? [];
    expect(tx).toBe(prisma);
    expect(input).toMatchObject({
      userId: USER,
      kind: 'ticket',
      title: 'Майстер-клас для дітей',
      expiresAt: new Date('2026-11-07T14:30:00.000Z'),
      sourceType: 'event',
      sourceId: registration.id,
      meta: { eventId: EVENT, registrationId: registration.id, adults: 1, children: 2, persons: 3 },
    });
    expect(input?.subtitle).toContain('Атріум, 1 поверх');
    expect(registration).toMatchObject({
      eventId: EVENT,
      userId: USER,
      persons: 3,
      status: 'active',
      voucherId: 'ticket-1',
      ticket: { id: 'ticket-1', kind: 'ticket' },
      cancelDeadline: new Date('2026-11-07T09:00:00.000Z'),
    });
    expect(prisma.events.get(EVENT)?.registeredCount).toBe(3);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'event.registered',
        aggregateId: registration.id,
        payload: expect.objectContaining({
          eventId: EVENT,
          userId: USER,
          voucherId: 'ticket-1',
          title: 'Майстер-клас для дітей',
          venue: 'Атріум, 1 поверх',
        }),
      }),
    ]);
  });

  it('refuses a second registration of the same member', async () => {
    const { service, vouchers } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    await expect(service.register(EVENT, USER, { adults: 1 })).rejects.toMatchObject({
      code: 'PC_EVENT_ALREADY_REGISTERED',
      status: 409,
    });
    expect(vouchers.issue).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh registration after a cancelled one', async () => {
    const { service, prisma } = setup();
    const first = await service.register(EVENT, USER, { adults: 1 });
    await service.cancelRegistration(EVENT, USER);
    const second = await service.register(EVENT, USER, { adults: 2 });
    expect(second.id).not.toBe(first.id);
    expect(prisma.registrations).toHaveLength(1);
    expect(prisma.events.get(EVENT)?.registeredCount).toBe(2);
  });

  it.each([
    [{ event: { capacity: 2, registeredCount: 1 } }, { adults: 2 }, 'PC_EVENT_FULL'],
    [{ registrationEnabled: false }, { adults: 1 }, 'PC_EVENT_REGISTRATION_CLOSED'],
    [{ event: { registrationOpen: false } }, { adults: 1 }, 'PC_EVENT_REGISTRATION_CLOSED'],
    [{ event: { status: 'cancelled' as const } }, { adults: 1 }, 'PC_EVENT_REGISTRATION_CLOSED'],
    [{ event: { status: 'draft' as const } }, { adults: 1 }, 'PC_EVENT_NOT_FOUND'],
    [{}, { adults: 0, children: 1 }, 'PC_EVENT_PERSONS_INVALID'],
    [{}, { adults: 3, children: 2 }, 'PC_EVENT_PERSONS_INVALID'],
    [
      { event: { maxPersonsPerRegistration: 2 } },
      { adults: 1, children: 2 },
      'PC_EVENT_PERSONS_INVALID',
    ],
    [
      { flagPayload: { maxPersonsPerRegistration: 3 } },
      { adults: 2, children: 2 },
      'PC_EVENT_PERSONS_INVALID',
    ],
    [
      { event: { admission: 'external' as const, externalUrl: 'https://example.com' } },
      { adults: 1 },
      'PC_EVENT_REGISTRATION_CLOSED',
    ],
  ])('rejects %j with persons %j: %s', async (options, persons, code) => {
    const { service, vouchers } = setup(options);
    await expect(service.register(EVENT, USER, persons)).rejects.toMatchObject({ code });
    expect(vouchers.issue).not.toHaveBeenCalled();
  });
});

describe('EventsService persons limit (no hard-coded 4)', () => {
  it('uses the events.registration flag payload when the event sets no limit', async () => {
    const { service } = setup({ flagPayload: { maxPersonsPerRegistration: 6 } });
    const registration = await service.register(EVENT, USER, { adults: 2, children: 4 });
    expect(registration.persons).toBe(6);
  });

  it('prefers the event limit over the flag payload', async () => {
    const { service } = setup({
      event: { maxPersonsPerRegistration: 5 },
      flagPayload: { maxPersonsPerRegistration: 2 },
    });
    await expect(service.register(EVENT, USER, { adults: 1, children: 4 })).resolves.toMatchObject({
      persons: 5,
    });
  });

  it('shows the effective limit on the event card', async () => {
    const withFlag = setup({ flagPayload: { maxPersonsPerRegistration: 6 } });
    await expect(withFlag.service.getForMember(EVENT, USER)).resolves.toMatchObject({
      maxPersonsPerRegistration: 6,
    });
    const fallback = setup({ flagPayload: { maxPersonsPerRegistration: 'many' } });
    await expect(fallback.service.getForMember(EVENT, USER)).resolves.toMatchObject({
      maxPersonsPerRegistration: 4,
    });
  });
});

describe('EventsService guest access and filters', () => {
  it('serves the poster and the detail to guests without registrations', async () => {
    const { service, prisma } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    prisma.eventRegistration.findMany.mockClear();

    const page = await service.list({ limit: 20 }, undefined);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: EVENT, registration: null, imageUrl: null });
    expect(prisma.eventRegistration.findMany).not.toHaveBeenCalled();

    const detail = await service.getForMember(EVENT, undefined);
    expect(detail).toMatchObject({
      id: EVENT,
      registration: null,
      category: 'kids',
      ageMin: 6,
      ageMax: 12,
      admission: 'registration',
      cancelDeadline: new Date('2026-11-07T09:00:00.000Z'),
    });
  });

  it('attaches the member registration on the poster and filters by category', async () => {
    const { service, prisma } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    const page = await service.list({ limit: 20, category: 'kids' }, USER);
    expect(page.items[0]?.registration).toMatchObject({ status: 'active' });
    expect(prisma.event.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { AND: expect.arrayContaining([{ category: 'kids' }]) },
      }),
    );
  });
});

describe('EventsService cancellation and outbox consumers', () => {
  it('cancels before the deadline: ticket cancelled without refund, seats released', async () => {
    const { service, prisma, vouchers, events } = setup();
    await service.register(EVENT, USER, { adults: 2 });

    const cancelled = await service.cancelRegistration(EVENT, USER);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toEqual(new Date(NOW));
    expect(vouchers.cancel).toHaveBeenCalledWith(
      {
        voucherId: 'ticket-1',
        reason: 'Cancelled by the member',
        actor: { type: 'user', id: USER },
        refundPoints: false,
      },
      prisma,
    );
    expect(prisma.events.get(EVENT)?.registeredCount).toBe(0);
    expect(events.at(-1)?.type).toBe('event.registration_cancelled');
  });

  it('refuses member cancellation after 11:00 Kyiv on the event day', async () => {
    const { service, clock } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    clock.set('2026-11-07T09:00:00.000Z');
    await expect(service.cancelRegistration(EVENT, USER)).rejects.toMatchObject({
      code: 'PC_EVENT_CANCEL_DEADLINE_PASSED',
      details: { deadline: '2026-11-07T09:00:00.000Z' },
    });
  });

  it('still closes the registration when the ticket is already final', async () => {
    const { service, vouchers } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    const ticket = vouchers.vouchers[0];
    if (ticket) {
      ticket.status = 'expired';
    }
    const cancelled = await service.cancelRegistration(EVENT, USER);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.ticket?.status).toBe('expired');
  });

  it('answers PC_EVENT_NOT_REGISTERED without an active registration', async () => {
    const { service } = setup();
    await expect(service.cancelRegistration(EVENT, USER)).rejects.toMatchObject({
      code: 'PC_EVENT_NOT_REGISTERED',
    });
  });

  it('marks the registration used when its ticket is redeemed (idempotent)', async () => {
    const { service } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    await expect(service.markRegistrationUsedByVoucher('ticket-1')).resolves.toBe('used');
    await expect(service.markRegistrationUsedByVoucher('ticket-1')).resolves.toBe('already_final');
    await expect(service.markRegistrationUsedByVoucher('unknown')).resolves.toBe('not_found');
  });

  it('closes the registration when rewards cancelled the ticket, without cancelling it again', async () => {
    const { service, vouchers, prisma } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    await expect(service.cancelRegistrationByVoucher('ticket-1', 'expired')).resolves.toBe(
      'cancelled',
    );
    expect(vouchers.cancel).not.toHaveBeenCalled();
    expect(prisma.registrations[0]?.status).toBe('cancelled');
    await expect(service.cancelRegistrationByVoucher('ticket-1', 'again')).resolves.toBe(
      'already_final',
    );
  });

  it('finishes published events whose end has passed', async () => {
    const { service, prisma } = setup({ event: { endsAt: new Date('2026-10-31T10:00:00.000Z') } });
    await expect(service.finishDueEvents(new Date(NOW))).resolves.toBe(1);
    expect(prisma.events.get(EVENT)?.status).toBe('finished');
  });

  it('shows the member registration with the ticket on the event detail', async () => {
    const { service } = setup();
    await service.register(EVENT, USER, { adults: 1 });
    const detail = await service.getForMember(EVENT, USER);
    expect(detail).toMatchObject({
      id: EVENT,
      seatsLeft: 29,
      registration: { status: 'active', ticket: { id: 'ticket-1' } },
    });
    const drafts = setup({ event: { status: 'draft' } });
    await expect(drafts.service.getForMember(EVENT, USER)).rejects.toMatchObject({
      code: 'PC_EVENT_NOT_FOUND',
    });
  });

  it('getEventSummary returns the contract shape or null', async () => {
    const { service } = setup();
    await expect(service.getEventSummary(EVENT)).resolves.toMatchObject({
      id: EVENT,
      capacity: 30,
      status: 'published',
    });
    await expect(service.getEventSummary('missing')).resolves.toBeNull();
  });
});
