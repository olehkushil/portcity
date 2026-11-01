import { Prisma } from '@prisma/client';
import { validateEnv } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import { FakeClock } from '../time/clock';
import { IdempotencyService, toJsonValue } from './idempotency.service';

interface FakeRow {
  scope: string;
  key: string;
  requestHash: string;
  status: number | null;
  response: unknown;
  createdAt: Date;
  expiresAt: Date;
}

function createService(
  initial: FakeRow | null,
  options: { duplicateOnCreate?: boolean; takeoverCount?: number; leaseSeconds?: number } = {},
) {
  const calls = {
    create: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = {
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue(initial),
      create: calls.create.mockImplementation(() => {
        if (options.duplicateOnCreate) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('duplicate', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          );
        }
        return Promise.resolve(initial);
      }),
      updateMany: calls.updateMany.mockResolvedValue({ count: options.takeoverCount ?? 1 }),
      deleteMany: calls.deleteMany.mockResolvedValue({ count: 3 }),
    },
  } as unknown as PrismaService;
  const clock = new FakeClock('2026-01-15T10:00:00Z');
  const config = validateEnv({ NODE_ENV: 'test', IDEMPOTENCY_TTL_HOURS: '24' });
  const lease =
    options.leaseSeconds === undefined
      ? undefined
      : { IDEMPOTENCY_LEASE_SECONDS: options.leaseSeconds };
  return { service: new IdempotencyService(prisma, clock, config, lease), calls, clock };
}

const liveRow = (overrides: Partial<FakeRow> = {}): FakeRow => ({
  scope: 'member:u1|POST|/api/v1/receipts/qr',
  key: 'key-12345678',
  requestHash: 'hash-a',
  status: 201,
  response: { id: 'r1' },
  createdAt: new Date('2026-01-15T09:00:00Z'),
  expiresAt: new Date('2026-01-16T09:00:00Z'),
  ...overrides,
});

describe('IdempotencyService', () => {
  it('claims a new key', async () => {
    const { service, calls } = createService(null);
    await expect(service.begin('s', 'key-12345678', 'hash-a')).resolves.toEqual({
      kind: 'proceed',
      claimedAt: new Date('2026-01-15T10:00:00Z'),
    });
    expect(calls.create).toHaveBeenCalledWith({
      data: {
        scope: 's',
        key: 'key-12345678',
        requestHash: 'hash-a',
        createdAt: new Date('2026-01-15T10:00:00Z'),
        expiresAt: new Date('2026-01-16T10:00:00Z'),
      },
    });
  });

  it('replays a completed request with the same hash', async () => {
    const { service } = createService(liveRow());
    await expect(service.begin('s', 'key-12345678', 'hash-a')).resolves.toEqual({
      kind: 'replay',
      status: 201,
      response: { id: 'r1' },
    });
  });

  it('reports mismatch and in-progress states', async () => {
    const mismatch = createService(liveRow());
    await expect(mismatch.service.begin('s', 'key-12345678', 'hash-b')).resolves.toEqual({
      kind: 'mismatch',
    });

    // Claimed 30 s ago: inside the default 120 s lease.
    const inProgress = createService(
      liveRow({ status: null, createdAt: new Date('2026-01-15T09:59:30Z') }),
    );
    await expect(inProgress.service.begin('s', 'key-12345678', 'hash-a')).resolves.toEqual({
      kind: 'in_progress',
    });
    expect(inProgress.calls.updateMany).not.toHaveBeenCalled();

    const raced = createService(null, { duplicateOnCreate: true });
    await expect(raced.service.begin('s', 'key-12345678', 'hash-a')).resolves.toEqual({
      kind: 'in_progress',
    });
  });

  it('takes over an expired key atomically', async () => {
    const expired = liveRow({ expiresAt: new Date('2026-01-15T09:59:59Z') });
    const taken = createService(expired, { takeoverCount: 1 });
    await expect(taken.service.begin('s', 'key-12345678', 'hash-b')).resolves.toEqual({
      kind: 'proceed',
      claimedAt: new Date('2026-01-15T10:00:00Z'),
    });
    expect(taken.calls.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          scope: 's',
          key: 'key-12345678',
          expiresAt: { lte: new Date('2026-01-15T10:00:00Z') },
        },
      }),
    );

    const lost = createService(expired, { takeoverCount: 0 });
    await expect(lost.service.begin('s', 'key-12345678', 'hash-b')).resolves.toEqual({
      kind: 'in_progress',
    });
  });

  it('lets a retry take over an in-progress key whose lease has expired (crashed request)', async () => {
    const claimedAt = new Date('2026-01-15T09:57:59Z');
    const stale = liveRow({ status: null, response: null, createdAt: claimedAt });
    const taken = createService(stale, { takeoverCount: 1 });
    await expect(taken.service.begin('s', 'key-12345678', 'hash-a')).resolves.toEqual({
      kind: 'proceed',
      claimedAt: new Date('2026-01-15T10:00:00Z'),
      tookOver: true,
    });
    expect(taken.calls.updateMany).toHaveBeenCalledWith({
      where: { scope: 's', key: 'key-12345678', status: null, createdAt: claimedAt },
      data: {
        createdAt: new Date('2026-01-15T10:00:00Z'),
        expiresAt: new Date('2026-01-16T10:00:00Z'),
      },
    });

    // A concurrent retry already took it over.
    const raced = createService(stale, { takeoverCount: 0 });
    await expect(raced.service.begin('s', 'key-12345678', 'hash-a')).resolves.toEqual({
      kind: 'in_progress',
    });

    // A different request with the same key stays a mismatch, even on a stale row.
    const other = createService(stale);
    await expect(other.service.begin('s', 'key-12345678', 'hash-b')).resolves.toEqual({
      kind: 'mismatch',
    });
  });

  it('honours IDEMPOTENCY_LEASE_SECONDS', async () => {
    const stale = liveRow({ status: null, createdAt: new Date('2026-01-15T09:57:59Z') });
    const longLease = createService(stale, { leaseSeconds: 600 });
    expect(longLease.service.leaseMs).toBe(600_000);
    await expect(longLease.service.begin('s', 'key-12345678', 'hash-a')).resolves.toEqual({
      kind: 'in_progress',
    });
    const shortLease = createService(
      liveRow({ status: null, createdAt: new Date('2026-01-15T09:59:50Z') }),
      { leaseSeconds: 5 },
    );
    await expect(shortLease.service.begin('s', 'key-12345678', 'hash-a')).resolves.toMatchObject({
      kind: 'proceed',
      tookOver: true,
    });
  });

  it('completes and abandons only the in-progress row the request claimed', async () => {
    const claimedAt = new Date('2026-01-15T10:00:00Z');
    const { service, calls } = createService(null);
    await expect(service.complete('s', 'k', 201, { id: 'r1' }, claimedAt)).resolves.toBe(true);
    expect(calls.updateMany).toHaveBeenCalledWith({
      where: { scope: 's', key: 'k', status: null, createdAt: claimedAt },
      data: { status: 201, response: { id: 'r1' } },
    });
    await service.abandon('s', 'k', claimedAt);
    expect(calls.deleteMany).toHaveBeenCalledWith({
      where: { scope: 's', key: 'k', status: null, createdAt: claimedAt },
    });

    const lost = createService(null, { takeoverCount: 0 });
    await expect(lost.service.complete('s', 'k', 201, {}, claimedAt)).resolves.toBe(false);
  });

  it('completes, abandons and purges', async () => {
    const { service, calls } = createService(null);
    await service.complete('s', 'k', 201, { id: 'r1', when: new Date('2026-01-15T10:00:00Z') });
    expect(calls.updateMany).toHaveBeenCalledWith({
      where: { scope: 's', key: 'k', status: null },
      data: { status: 201, response: { id: 'r1', when: '2026-01-15T10:00:00.000Z' } },
    });
    await service.abandon('s', 'k');
    expect(calls.deleteMany).toHaveBeenCalledWith({
      where: { scope: 's', key: 'k', status: null },
    });
    await expect(service.purgeExpired()).resolves.toBe(3);
    expect(calls.deleteMany).toHaveBeenLastCalledWith({
      where: { expiresAt: { lt: new Date('2026-01-15T10:00:00Z') } },
    });
  });

  it('maps undefined responses to JSON null', () => {
    expect(toJsonValue(undefined)).toBe(Prisma.JsonNull);
    expect(toJsonValue(null)).toBe(Prisma.JsonNull);
    expect(toJsonValue({ a: 1 })).toEqual({ a: 1 });
    expect(toJsonValue('text')).toBe('text');
  });
});
