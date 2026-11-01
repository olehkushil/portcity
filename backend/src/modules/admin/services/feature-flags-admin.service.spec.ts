import type { AdminAuditPort, AuditEntry } from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import type { FeatureFlagsService } from '../../../common/feature-flags/feature-flags.service';
import type { OutboxEventInput } from '../../../common/outbox/outbox.types';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { FeatureFlagsAdminService } from './feature-flags-admin.service';

interface FlagRow {
  key: string;
  enabled: boolean;
  payload: unknown;
  updatedAt: Date;
}

class FakePrisma {
  readonly rows = new Map<string, FlagRow>();

  private normalise(payload: unknown): unknown {
    // Prisma.JsonNull is an object instance; the fake stores it as plain null.
    return payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      Object.getPrototypeOf(payload) !== Object.prototype
      ? null
      : payload;
  }

  readonly featureFlag = {
    findMany: async () => [...this.rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    findUnique: async (args: { where: { key: string } }) => this.rows.get(args.where.key) ?? null,
    create: async (args: { data: FlagRow }) => {
      const row = { ...args.data, payload: this.normalise(args.data.payload) };
      this.rows.set(row.key, row);
      return row;
    },
    update: async (args: { where: { key: string }; data: Partial<FlagRow> }) => {
      const row = this.rows.get(args.where.key);
      if (!row) {
        throw new Error('missing');
      }
      Object.assign(row, args.data, {
        payload: this.normalise(args.data.payload ?? row.payload),
      });
      return row;
    },
    delete: async (args: { where: { key: string } }) => {
      const row = this.rows.get(args.where.key);
      this.rows.delete(args.where.key);
      return row;
    },
  };

  withTx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function setup() {
  const prisma = new FakePrisma();
  const clock = new FakeClock('2026-03-01T08:00:00.000Z');
  const events: OutboxEventInput[] = [];
  const outbox = {
    publish: jest.fn(async (_tx: unknown, event: OutboxEventInput) => {
      events.push(event);
      return 'evt';
    }),
  };
  const audits: AuditEntry[] = [];
  const audit: AdminAuditPort = {
    audit: jest.fn(async (entry: AuditEntry) => {
      audits.push(entry);
      return 'audit';
    }),
  };
  const flags = { invalidate: jest.fn() };
  const service = new FeatureFlagsAdminService(
    prisma as unknown as PrismaService,
    clock,
    outbox as unknown as OutboxService,
    flags as unknown as FeatureFlagsService,
    audit,
  );
  return { service, prisma, events, audits, flags };
}

const ACTOR = { id: '01900000-0000-7000-8000-0000000000c2', ip: '10.0.0.2' };

describe('FeatureFlagsAdminService', () => {
  it('creates a flag, audits it, publishes flag.updated and evicts the cache', async () => {
    const { service, events, audits, flags } = setup();

    const view = await service.upsert(
      'parking.info_mode',
      { enabled: true, payload: { zones: ['surface'] }, reason: ' Запуск ' },
      ACTOR,
    );

    expect(view).toMatchObject({
      key: 'parking.info_mode',
      enabled: true,
      payload: { zones: ['surface'] },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'feature_flag.create',
      entityType: 'feature_flag',
      entityId: 'parking.info_mode',
      before: null,
      reason: 'Запуск',
      ip: '10.0.0.2',
    });
    expect(events.map((event) => event.type)).toEqual(['flag.updated']);
    expect(events[0]?.payload).toEqual({
      key: 'parking.info_mode',
      enabled: true,
      updatedById: ACTOR.id,
    });
    expect(flags.invalidate).toHaveBeenCalledWith('parking.info_mode');
  });

  it('treats a write without changes as a no-op', async () => {
    const { service, audits, events } = setup();
    await service.upsert('events.registration', { enabled: true }, ACTOR);
    await service.upsert('events.registration', { enabled: true }, ACTOR);
    expect(audits).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('updates an existing flag, keeping the payload when it is omitted', async () => {
    const { service, audits } = setup();
    await service.upsert('parking.info_mode', { enabled: true, payload: { a: 1 } }, ACTOR);
    const view = await service.upsert('parking.info_mode', { enabled: false }, ACTOR);
    expect(view).toMatchObject({ enabled: false, payload: { a: 1 } });
    expect(audits[1]).toMatchObject({
      action: 'feature_flag.update',
      before: { enabled: true },
      after: { enabled: false },
      reason: null,
    });
  });

  it('rejects malformed keys', async () => {
    const { service } = setup();
    await expect(service.upsert('Parking Info', { enabled: true }, ACTOR)).rejects.toMatchObject({
      code: 'PC_FEATURE_FLAG_KEY_INVALID',
    });
    await expect(service.get('../etc')).rejects.toMatchObject({
      code: 'PC_FEATURE_FLAG_KEY_INVALID',
    });
  });

  it('answers 404 for unknown flags on get and delete', async () => {
    const { service, flags } = setup();
    const error = await service.get('missing.flag').catch((thrown: unknown) => thrown);
    expect(DomainError.is(error) && error.code).toBe('PC_FEATURE_FLAG_NOT_FOUND');
    await expect(service.remove('missing.flag', ACTOR)).rejects.toMatchObject({
      code: 'PC_FEATURE_FLAG_NOT_FOUND',
      status: 404,
    });
    expect(flags.invalidate).not.toHaveBeenCalled();
  });

  it('deletes a flag with an audit row and a disabled flag.updated event', async () => {
    const { service, prisma, audits, events, flags } = setup();
    await service.upsert('receipts.manual_submission', { enabled: true }, ACTOR);

    await service.remove('receipts.manual_submission', ACTOR, 'Більше не потрібен');

    expect(prisma.rows.has('receipts.manual_submission')).toBe(false);
    expect(audits.at(-1)).toMatchObject({
      action: 'feature_flag.delete',
      after: null,
      reason: 'Більше не потрібен',
    });
    expect(events.at(-1)?.payload).toMatchObject({ enabled: false });
    expect(flags.invalidate).toHaveBeenLastCalledWith('receipts.manual_submission');
  });

  it('lists flags ordered by key', async () => {
    const { service } = setup();
    await service.upsert('z.last', { enabled: false }, ACTOR);
    await service.upsert('a.first', { enabled: true }, ACTOR);
    expect((await service.list()).map((flag) => flag.key)).toEqual(['a.first', 'z.last']);
  });
});
