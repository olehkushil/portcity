import type { SupportRequest } from '@prisma/client';
import type { AdminAuditPort, AuditEntry } from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import type { OutboxEventInput } from '../../../common/outbox/outbox.types';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { InMemoryStorageAdapter } from '../../../common/storage/in-memory-storage.adapter';
import { FakeClock } from '../../../common/time/clock';
import { SupportRequestsService } from './support-requests.service';

const MEMBER = '01900000-0000-7000-8000-000000000001';
const OTHER_MEMBER = '01900000-0000-7000-8000-000000000002';
const SUPPORT = { id: '01900000-0000-7000-8000-0000000000c1', ip: '10.0.0.1' };

type Where = {
  id?: string;
  userId?: string;
  status?: string;
  createdAt?: { gte: Date };
  photoKey?: { not: null };
  OR?: Array<{ message?: { not: string }; photoKey?: { not: null } }>;
};

function matches(row: SupportRequest, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.createdAt && row.createdAt.getTime() < where.createdAt.gte.getTime()) return false;
  if (where.photoKey && row.photoKey === null) return false;
  if (
    where.OR &&
    !where.OR.some(
      (condition) =>
        (condition.message !== undefined && row.message !== condition.message.not) ||
        (condition.photoKey !== undefined && row.photoKey !== null),
    )
  ) {
    return false;
  }
  return true;
}

/** In-memory support_requests with the database sequence emulated from 1042. */
class FakePrisma {
  readonly rows: SupportRequest[] = [];
  private nextNumber = 1042;

  readonly supportRequest = {
    create: async (args: {
      data: Omit<SupportRequest, 'number' | 'adminNote' | 'resolvedById' | 'resolvedAt'>;
    }) => {
      const row: SupportRequest = {
        number: this.nextNumber++,
        adminNote: null,
        resolvedById: null,
        resolvedAt: null,
        ...args.data,
      };
      this.rows.push(row);
      return { ...row };
    },
    count: async (args: { where: Where }) =>
      this.rows.filter((row) => matches(row, args.where)).length,
    findUnique: async (args: { where: { id: string } }) => {
      const row = this.rows.find((entry) => entry.id === args.where.id);
      return row ? { ...row } : null;
    },
    findMany: async (args: { where: Where; take: number }) =>
      this.rows
        .filter((row) => matches(row, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, args.take)
        .map((row) => ({ ...row })),
    update: async (args: { where: { id: string }; data: Partial<SupportRequest> }) => {
      const row = this.rows.find((entry) => entry.id === args.where.id);
      if (!row) {
        throw new Error('row missing');
      }
      Object.assign(row, args.data);
      return { ...row };
    },
    updateMany: async (args: { where: Where; data: Partial<SupportRequest> }) => {
      const rows = this.rows.filter((row) => matches(row, args.where));
      for (const row of rows) {
        Object.assign(row, args.data);
      }
      return { count: rows.length };
    },
  };

  readonly $executeRaw = jest.fn(async () => 1);
  readonly $queryRaw = jest.fn(async () => []);

  withTx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function setup() {
  const prisma = new FakePrisma();
  // 12:00 Kyiv (UTC+2).
  const clock = new FakeClock('2026-11-01T10:00:00.000Z');
  const events: OutboxEventInput[] = [];
  const outbox = {
    publish: jest.fn(async (_tx: unknown, event: OutboxEventInput) => {
      events.push(event);
      return `evt-${events.length}`;
    }),
  };
  const audits: AuditEntry[] = [];
  const audit: AdminAuditPort = {
    audit: jest.fn(async (entry: AuditEntry) => {
      audits.push(entry);
      return `audit-${audits.length}`;
    }),
  };
  const storage = new InMemoryStorageAdapter('memory', clock);
  const service = new SupportRequestsService(
    prisma as unknown as PrismaService,
    clock,
    outbox as unknown as OutboxService,
    storage,
    audit,
  );
  return { service, prisma, clock, events, audits, storage };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (DomainError.is(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a DomainError');
}

const REQUEST = {
  topic: 'parking' as const,
  relatedType: 'parking_session' as const,
  relatedId: '01900000-0000-7000-8000-0000000000d1',
  message: '  Оплатив у застосунку, шлагбаум не відкрився  ',
};

describe('SupportRequestsService (member side)', () => {
  it('creates a request with the next human number and publishes support.request_created', async () => {
    const { service, prisma, events } = setup();
    const created = await service.create(MEMBER, REQUEST);
    expect(created).toEqual({ id: prisma.rows[0]?.id, number: 1042 });
    expect(prisma.rows[0]).toMatchObject({
      userId: MEMBER,
      topic: 'parking',
      status: 'new',
      message: 'Оплатив у застосунку, шлагбаум не відкрився',
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'support.request_created',
        aggregateType: 'support_request',
        aggregateId: created.id,
        payload: {
          requestId: created.id,
          number: 1042,
          userId: MEMBER,
          topic: 'parking',
          relatedType: 'parking_session',
          relatedId: REQUEST.relatedId,
          message: 'Оплатив у застосунку, шлагбаум не відкрився',
          photoKey: null,
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      }),
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    await expect(service.create(MEMBER, REQUEST)).resolves.toMatchObject({ number: 1043 });
  });

  it('allows 5 requests per Kyiv day and resets at midnight Kyiv', async () => {
    const { service, clock, prisma } = setup();
    for (let index = 0; index < 5; index += 1) {
      await service.create(MEMBER, REQUEST);
    }
    const error = await service.create(MEMBER, REQUEST).catch((caught: unknown) => caught);
    expect(DomainError.is(error) && error.code).toBe('PC_SUPPORT_REQUEST_DAILY_LIMIT');
    expect(DomainError.is(error) && error.status).toBe(429);
    expect(DomainError.is(error) && error.details).toMatchObject({
      limit: 5,
      retryAfter: '2026-11-01T22:00:00.000Z',
    });
    // Another member is not affected.
    await expect(service.create(OTHER_MEMBER, REQUEST)).resolves.toMatchObject({ number: 1047 });
    // 00:00 Kyiv next day.
    clock.set('2026-11-01T22:00:00.000Z');
    await expect(service.create(MEMBER, REQUEST)).resolves.toMatchObject({ number: 1048 });
    expect(prisma.rows).toHaveLength(7);
  });

  it('accepts only photos uploaded by the same member', async () => {
    const { service, storage } = setup();
    const upload = await service.createPhotoUpload(MEMBER, {
      contentType: 'image/jpeg',
      sizeBytes: 200_000,
    });
    expect(upload.key).toMatch(new RegExp(`^support/${MEMBER}/2026/11/.+\\.jpg$`));
    expect(upload.method).toBe('PUT');
    expect(storage.pendingUploads.has(upload.key)).toBe(true);
    await expect(
      service.create(MEMBER, { ...REQUEST, photoKey: upload.key }),
    ).resolves.toMatchObject({ number: 1042 });
    expect(await codeOf(service.create(OTHER_MEMBER, { ...REQUEST, photoKey: upload.key }))).toBe(
      'PC_SUPPORT_REQUEST_PHOTO_INVALID',
    );
  });

  it('refuses unsupported photo uploads', async () => {
    const { service } = setup();
    expect(
      await codeOf(
        service.createPhotoUpload(MEMBER, { contentType: 'application/pdf', sizeBytes: 10 }),
      ),
    ).toBe('PC_SUPPORT_REQUEST_PHOTO_INVALID');
    expect(
      await codeOf(
        service.createPhotoUpload(MEMBER, { contentType: 'image/png', sizeBytes: 6 * 1024 * 1024 }),
      ),
    ).toBe('PC_SUPPORT_REQUEST_PHOTO_INVALID');
  });

  it('lists only the member own requests, newest first, with paging', async () => {
    const { service, clock } = setup();
    await service.create(MEMBER, { ...REQUEST, message: 'Перше звернення' });
    clock.advance(60_000);
    await service.create(OTHER_MEMBER, { ...REQUEST, message: 'Чуже звернення' });
    clock.advance(60_000);
    await service.create(MEMBER, { ...REQUEST, topic: 'receipt', message: 'Друге звернення' });

    const first = await service.listMine(MEMBER, { limit: 1 });
    expect(first.items.map((item) => item.message)).toEqual(['Друге звернення']);
    expect(first.items[0]).toMatchObject({ topic: 'receipt', hasPhoto: false, status: 'new' });
    expect(first.items[0]).not.toHaveProperty('userId');
    expect(first.nextCursor).not.toBeNull();
  });
});

describe('SupportRequestsService (back office)', () => {
  async function seeded() {
    const context = setup();
    const created = await context.service.create(MEMBER, {
      ...REQUEST,
      photoKey: `support/${MEMBER}/2026/11/photo.jpg`,
    });
    return { ...context, created };
  }

  it('shows the request with a short-lived photo link', async () => {
    const { service, created } = await seeded();
    const dto = await service.getForAdmin(created.id);
    expect(dto).toMatchObject({
      id: created.id,
      number: 1042,
      userId: MEMBER,
      hasPhoto: true,
      photoKey: `support/${MEMBER}/2026/11/photo.jpg`,
      adminNote: null,
    });
    expect(dto.photoUrl).toMatch(/^memory:\/\//);
    expect(await codeOf(service.getForAdmin('01900000-0000-7000-8000-00000000dead'))).toBe(
      'PC_SUPPORT_REQUEST_NOT_FOUND',
    );
  });

  it('moves the status, records who resolved it and audits every change', async () => {
    const { service, created, audits, clock } = await seeded();
    const inProgress = await service.update(created.id, { status: 'in_progress' }, SUPPORT);
    expect(inProgress).toMatchObject({ status: 'in_progress', resolvedById: null });

    clock.advance(3_600_000);
    const resolved = await service.update(
      created.id,
      { status: 'resolved', note: '  Оператор підтвердив оплату  ' },
      SUPPORT,
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      adminNote: 'Оператор підтвердив оплату',
      resolvedById: SUPPORT.id,
      resolvedAt: new Date('2026-11-01T11:00:00.000Z'),
    });

    const noted = await service.update(
      created.id,
      { status: 'resolved', note: 'Учаснику передзвонили' },
      SUPPORT,
    );
    expect(noted).toMatchObject({ status: 'resolved', adminNote: 'Учаснику передзвонили' });

    const reopened = await service.update(created.id, { status: 'in_progress' }, SUPPORT);
    expect(reopened).toMatchObject({ resolvedById: null, resolvedAt: null });

    expect(audits.map((entry) => entry.action)).toEqual([
      'support_request.status_change',
      'support_request.status_change',
      'support_request.note',
      'support_request.status_change',
    ]);
    expect(audits[1]).toMatchObject({
      actor: { type: 'admin', id: SUPPORT.id },
      entityType: 'support_request',
      entityId: created.id,
      before: { status: 'in_progress' },
      after: { status: 'resolved' },
      reason: 'Оператор підтвердив оплату',
      ip: '10.0.0.1',
    });
  });

  it('keeps a closed request final', async () => {
    const { service, created } = await seeded();
    await service.update(created.id, { status: 'closed' }, SUPPORT);
    expect(await codeOf(service.update(created.id, { status: 'in_progress' }, SUPPORT))).toBe(
      'PC_SUPPORT_REQUEST_INVALID_TRANSITION',
    );
    expect(
      await codeOf(service.update(created.id, { status: 'closed', note: 'ще' }, SUPPORT)),
    ).toBe('PC_SUPPORT_REQUEST_INVALID_TRANSITION');
  });

  it('filters the back-office list by status and member', async () => {
    const { service, created } = await seeded();
    await service.create(OTHER_MEMBER, REQUEST);
    await service.update(created.id, { status: 'in_progress' }, SUPPORT);
    const fresh = await service.listForAdmin({ status: 'new' }, { limit: 20 });
    expect(fresh.items.map((item) => item.userId)).toEqual([OTHER_MEMBER]);
    const mine = await service.listForAdmin({ userId: MEMBER }, { limit: 20 });
    expect(mine.items.map((item) => item.number)).toEqual([1042]);
    expect(mine.items[0]?.photoUrl).toBeNull();
  });
});

describe('SupportRequestsService (account erasure, user.deleted)', () => {
  const PLACEHOLDER = 'Текст звернення видалено разом з акаунтом учасника.';

  it('lists the photo keys and anonymises only the deleted member, once', async () => {
    const { service, prisma, clock } = setup();
    const photoKey = `support/${MEMBER}/2026/11/photo.jpg`;
    const withPhoto = await service.create(MEMBER, { ...REQUEST, photoKey });
    const plain = await service.create(MEMBER, REQUEST);
    await service.create(OTHER_MEMBER, REQUEST);

    expect(await service.listPhotoKeysOfUser(MEMBER)).toEqual([photoKey]);
    expect(await service.listPhotoKeysOfUser(OTHER_MEMBER)).toEqual([]);

    clock.advance(60_000);
    expect(await service.eraseUserRequests(MEMBER, PLACEHOLDER)).toBe(2);
    const erased = prisma.rows.filter((row) => row.userId === MEMBER);
    expect(erased.map((row) => [row.id, row.message, row.photoKey])).toEqual([
      [withPhoto.id, PLACEHOLDER, null],
      [plain.id, PLACEHOLDER, null],
    ]);
    expect(erased.every((row) => row.updatedAt.toISOString() === '2026-11-01T10:01:00.000Z')).toBe(
      true,
    );
    // Number, topic and status stay as the handling history.
    expect(erased[0]).toMatchObject({ number: 1042, topic: 'parking', status: 'new' });
    expect(prisma.rows.find((row) => row.userId === OTHER_MEMBER)?.message).toBe(
      'Оплатив у застосунку, шлагбаум не відкрився',
    );
    // A replay changes nothing.
    expect(await service.eraseUserRequests(MEMBER, PLACEHOLDER)).toBe(0);
    expect(await service.listPhotoKeysOfUser(MEMBER)).toEqual([]);
  });
});
