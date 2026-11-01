import { validateEnv } from '../config/env.schema';
import type { PrismaService } from '../prisma/prisma.service';
import { InMemoryQueue } from '../queue/in-memory-queue';
import type { QueueRegistry } from '../queue/queue-registry.service';
import { FakeClock } from '../time/clock';
import { OutboxDispatcher } from './outbox-dispatcher';
import { OutboxRouter } from './outbox-router';
import { UNROUTED_GIVE_UP_ATTEMPTS } from './outbox.types';

interface Row {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

function createHarness(rows: Row[]) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    outboxEvent: { updateMany },
  };
  const prisma = {
    withTx: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const queues = new Map<string, InMemoryQueue>();
  const registry = {
    get: (name: string) => {
      const queue = queues.get(name);
      if (!queue) {
        throw new Error(`Queue "${name}" is not registered`);
      }
      return queue;
    },
  } as unknown as QueueRegistry;
  const router = new OutboxRouter();
  const clock = new FakeClock('2026-01-15T10:00:00Z');
  const config = validateEnv({ NODE_ENV: 'test', OUTBOX_BATCH_SIZE: '50' });
  const dispatcher = new OutboxDispatcher(prisma, router, registry, clock, config);
  return { dispatcher, router, queues, updateMany, tx };
}

const row = (id: string, type: string, attempts = 0): Row => ({
  id,
  aggregate_type: 'receipt',
  aggregate_id: `agg-${id}`,
  type,
  payload: { receiptId: `agg-${id}`, points: 30 },
  occurred_at: new Date('2026-01-15T09:59:00Z'),
  attempts,
});

describe('OutboxDispatcher', () => {
  it('routes events to every consumer queue and marks them published', async () => {
    const { dispatcher, router, queues, updateMany } = createHarness([
      row('e1', 'receipt.credited'),
      row('e2', 'receipt.rejected'),
    ]);
    queues.set('notifications-push', new InMemoryQueue('notifications-push'));
    queues.set('reports-nightly', new InMemoryQueue('reports-nightly'));
    router
      .addRoute('receipt.credited', 'notifications-push')
      .addRoute('receipt.*', 'reports-nightly');

    const result = await dispatcher.tick();
    expect(result).toEqual({
      fetched: 2,
      published: 2,
      ignored: 0,
      unrouted: 0,
      dropped: 0,
      failed: 0,
    });

    const pushJobs = queues.get('notifications-push')!.jobs;
    expect(pushJobs).toHaveLength(1);
    expect(pushJobs[0]).toMatchObject({
      id: 'outbox-e1',
      name: 'receipt.credited',
      data: {
        eventId: 'e1',
        type: 'receipt.credited',
        aggregateType: 'receipt',
        aggregateId: 'agg-e1',
        payload: { receiptId: 'agg-e1', points: 30 },
        occurredAt: '2026-01-15T09:59:00.000Z',
      },
    });
    expect(queues.get('reports-nightly')!.jobs.map((job) => job.id)).toEqual([
      'outbox-e1',
      'outbox-e2',
    ]);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['e1', 'e2'] } },
      data: { publishedAt: new Date('2026-01-15T10:00:00Z') },
    });
  });

  it('keeps unrouted events for retry and drops them after the give-up threshold', async () => {
    const { dispatcher, updateMany } = createHarness([
      row('fresh', 'voucher.activated', 0),
      row('old', 'voucher.activated', UNROUTED_GIVE_UP_ATTEMPTS - 1),
    ]);

    const result = await dispatcher.tick();
    expect(result).toEqual({
      fetched: 2,
      published: 0,
      ignored: 0,
      unrouted: 2,
      dropped: 1,
      failed: 0,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['old'] } } }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['fresh'] } },
      data: { attempts: { increment: 1 } },
    });
  });

  it('marks audit-only events published without a job, unless a consumer routes them', async () => {
    const { dispatcher, router, queues, updateMany } = createHarness([
      row('a1', 'voucher.activated'),
      row('a2', 'receipt.submitted'),
    ]);
    router.ignore('voucher.activated', 'the app shows the code itself');
    router.ignore('receipt.submitted', 'audit trail');
    queues.set('reports-nightly', new InMemoryQueue('reports-nightly'));
    router.addRoute('receipt.submitted', 'reports-nightly');

    const result = await dispatcher.tick();
    expect(result).toEqual({
      fetched: 2,
      published: 1,
      ignored: 1,
      unrouted: 0,
      dropped: 0,
      failed: 0,
    });
    expect(queues.get('reports-nightly')!.jobs.map((job) => job.id)).toEqual(['outbox-a2']);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      data: { publishedAt: new Date('2026-01-15T10:00:00Z') },
    });
  });

  it('counts enqueue failures and increments attempts without publishing', async () => {
    const { dispatcher, router, queues, updateMany } = createHarness([
      row('e1', 'receipt.credited'),
    ]);
    router.addRoute('receipt.credited', 'missing-queue');
    queues.clear();

    const result = await dispatcher.tick();
    expect(result).toEqual({
      fetched: 1,
      published: 0,
      ignored: 0,
      unrouted: 0,
      dropped: 0,
      failed: 1,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['e1'] } },
      data: { attempts: { increment: 1 } },
    });
  });

  it('does nothing when there are no events', async () => {
    const { dispatcher, updateMany } = createHarness([]);
    expect(await dispatcher.tick()).toEqual({
      fetched: 0,
      published: 0,
      ignored: 0,
      unrouted: 0,
      dropped: 0,
      failed: 0,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
