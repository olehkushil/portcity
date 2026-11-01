import type { ContentImportRun } from '@prisma/client';
import type { AdminAuditPort } from '../../../common/contracts/admin';
import { encodeCursor } from '../../../common/pagination/cursor';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import type { ContentImportQueue } from './content-import.queue';
import { ContentImportService } from './content-import.service';
import { toImportRunDto } from './mappers';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const ACTOR = { id: '0192f3a0-0000-7000-8000-00000000a001', ip: '10.0.0.1' };

function setup() {
  const tx = {
    tenant: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const contentImportRun = {
    create: jest.fn(async ({ data }: { data: Partial<ContentImportRun> }) => ({
      finishedAt: null,
      stats: null,
      error: null,
      ...data,
    })),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Partial<ContentImportRun> }) => ({
        id: where.id,
        source: 'wordpress',
        startedAt: NOW,
        finishedAt: null,
        stats: null,
        error: null,
        ...data,
      }),
    ),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  };
  const prisma = {
    contentImportRun,
    withTx: jest.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(tx)),
  };
  const audit = { audit: jest.fn().mockResolvedValue('audit-1') } satisfies AdminAuditPort;
  const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new ContentImportService(
    prisma as unknown as PrismaService,
    new FakeClock(NOW),
    audit,
    queue as unknown as ContentImportQueue,
  );
  return { service, prisma, tx, contentImportRun, audit, queue };
}

describe('ContentImportService', () => {
  it('imports WordPress posts and items, records a succeeded run and audits it', async () => {
    const { service, tx, contentImportRun, audit } = setup();
    tx.tenant.findMany.mockResolvedValue([
      {
        id: 'tenant-1',
        slug: 'intertop',
        name: 'INTERTOP',
        category: 'fashion',
        floor: 1,
        website: null,
        phone: null,
        description: null,
        logoKey: null,
      },
    ]);

    const run = await service.run(
      {
        source: 'wordpress',
        items: [{ slug: 'intertop', name: 'INTERTOP', floor: 2 }],
        posts: [
          { id: 15, slug: 'aroma-kava', title: { rendered: 'Aroma Kava' } },
          { id: 16, title: { rendered: '' } },
        ],
      },
      ACTOR,
    );

    expect(contentImportRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: 'wordpress', status: 'running', startedAt: NOW }),
    });
    expect(tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(tx.tenant.create.mock.calls[0][0].data).toMatchObject({
      slug: 'aroma-kava',
      name: 'Aroma Kava',
      participates: false,
      status: 'active',
    });
    expect(tx.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: { floor: 2, updatedAt: NOW },
    });
    expect(run.status).toBe('succeeded');
    expect(run.finishedAt).toEqual(NOW);
    const dto = toImportRunDto(run);
    expect(dto.stats).toMatchObject({
      source: 'wordpress',
      dryRun: false,
      received: 2,
      created: 1,
      updated: 1,
      createdSlugs: ['aroma-kava'],
      updatedSlugs: ['intertop'],
    });
    expect(dto.stats?.warnings).toContain('1 WordPress post(s) without a title skipped');
    expect(audit.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'admin', id: ACTOR.id },
        action: 'content_import.run',
        entityType: 'content_import_run',
        entityId: run.id,
        after: expect.objectContaining({ created: 1, updated: 1, dryRun: false }),
      }),
    );
  });

  it('writes nothing to tenants in dry run', async () => {
    const { service, tx } = setup();
    const run = await service.run(
      { source: 'manual', dryRun: true, items: [{ name: 'New Shop' }] },
      ACTOR,
    );
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(toImportRunDto(run).stats).toMatchObject({ dryRun: true, created: 1 });
  });

  it('rejects an import with nothing usable before creating a run', async () => {
    const { service, contentImportRun } = setup();
    await expect(
      service.run({ source: 'wordpress', posts: [{ id: 1, title: { rendered: '' } }] }, ACTOR),
    ).rejects.toMatchObject({
      code: 'PC_CONTENT_IMPORT_EMPTY',
      status: 422,
      details: { skippedPosts: 1 },
    });
    expect(contentImportRun.create).not.toHaveBeenCalled();
  });

  it('marks the run failed and rethrows when the import transaction fails', async () => {
    const { service, tx, contentImportRun, audit } = setup();
    tx.tenant.findMany.mockRejectedValue(new Error('connection reset'));

    await expect(
      service.run({ source: 'manual', items: [{ name: 'Shop' }] }, ACTOR),
    ).rejects.toThrow('connection reset');

    expect(contentImportRun.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: { status: 'failed', finishedAt: NOW, error: 'connection reset' },
    });
    expect(audit.audit).not.toHaveBeenCalled();
  });

  it('still rethrows the import error when marking the run failed fails too', async () => {
    const { service, tx, contentImportRun } = setup();
    tx.tenant.findMany.mockRejectedValue(new Error('boom'));
    contentImportRun.update.mockRejectedValue(new Error('db down'));
    await expect(
      service.run({ source: 'manual', items: [{ name: 'Shop' }] }, ACTOR),
    ).rejects.toThrow('boom');
  });

  describe('async mode (content-import queue)', () => {
    it('creates a running run, enqueues the request and touches no tenant', async () => {
      const { service, tx, queue, audit } = setup();
      const run = await service.run(
        { source: 'manual', async: true, dryRun: false, items: [{ name: 'New Shop' }] },
        ACTOR,
      );
      expect(run).toMatchObject({ status: 'running', source: 'manual' });
      expect(queue.enqueue).toHaveBeenCalledWith({
        runId: run.id,
        actor: { id: ACTOR.id, ip: ACTOR.ip },
        source: 'manual',
        dryRun: false,
        items: [{ name: 'New Shop' }],
      });
      expect(tx.tenant.create).not.toHaveBeenCalled();
      expect(audit.audit).not.toHaveBeenCalled();
    });

    it('marks the run failed when the job cannot be enqueued', async () => {
      const { service, queue, contentImportRun } = setup();
      queue.enqueue.mockRejectedValue(new Error('redis down'));
      await expect(
        service.run({ source: 'manual', async: true, items: [{ name: 'Shop' }] }, ACTOR),
      ).rejects.toThrow('redis down');
      expect(contentImportRun.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: { status: 'failed', finishedAt: NOW, error: 'redis down' },
      });
    });

    it('executes a queued run and finishes it', async () => {
      const { service, tx, contentImportRun, audit } = setup();
      contentImportRun.findUnique.mockResolvedValue({ id: 'run-1', status: 'running' });
      const status = await service.executeQueued({
        runId: 'run-1',
        actor: { id: ACTOR.id, ip: null },
        source: 'manual',
        items: [{ name: 'Queued Shop' }],
      });
      expect(status).toBe('succeeded');
      expect(tx.tenant.create).toHaveBeenCalledTimes(1);
      expect(contentImportRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({ status: 'succeeded', finishedAt: NOW }),
        }),
      );
      expect(audit.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'content_import.run', entityId: 'run-1' }),
      );
    });

    it('records a failed queued import without rethrowing', async () => {
      const { service, tx, contentImportRun } = setup();
      contentImportRun.findUnique.mockResolvedValue({ id: 'run-2', status: 'running' });
      tx.tenant.findMany.mockRejectedValue(new Error('deadlock'));
      const status = await service.executeQueued({
        runId: 'run-2',
        actor: { id: ACTOR.id, ip: null },
        source: 'manual',
        items: [{ name: 'Shop' }],
      });
      expect(status).toBe('failed');
      expect(contentImportRun.update).toHaveBeenCalledWith({
        where: { id: 'run-2' },
        data: { status: 'failed', finishedAt: NOW, error: 'deadlock' },
      });
    });

    it('skips a run that is already finished or unknown (job retry)', async () => {
      const { service, tx, contentImportRun } = setup();
      contentImportRun.findUnique.mockResolvedValueOnce({ id: 'run-3', status: 'succeeded' });
      const job = {
        runId: 'run-3',
        actor: { id: ACTOR.id, ip: null },
        source: 'manual' as const,
        items: [{ name: 'Shop' }],
      };
      await expect(service.executeQueued(job)).resolves.toBe('skipped');
      contentImportRun.findUnique.mockResolvedValueOnce(null);
      await expect(service.executeQueued(job)).resolves.toBe('skipped');
      expect(tx.tenant.findMany).not.toHaveBeenCalled();
    });
  });

  it('lists runs newest first with a status filter and cursor', async () => {
    const { service, contentImportRun } = setup();
    contentImportRun.findMany.mockResolvedValue([]);
    await service.list({ status: 'failed', cursor: encodeCursor({ id: 'run-9' }), limit: 5 });
    expect(contentImportRun.findMany).toHaveBeenCalledWith({
      where: { status: 'failed', id: { lt: 'run-9' } },
      orderBy: { id: 'desc' },
      take: 6,
    });
  });

  it('getById answers 404 for an unknown run', async () => {
    const { service, contentImportRun } = setup();
    contentImportRun.findUnique.mockResolvedValue(null);
    await expect(service.getById('run-1')).rejects.toMatchObject({
      code: 'PC_CONTENT_IMPORT_NOT_FOUND',
      status: 404,
    });
  });
});
