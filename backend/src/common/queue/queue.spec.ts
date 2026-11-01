import { buildBullQueueOptions } from './bull-options';
import { InMemoryQueue } from './in-memory-queue';
import type { QueueRegistry } from './queue-registry.service';
import { WorkerSchedules } from './worker-schedules.service';

describe('queue infrastructure', () => {
  it('builds BullMQ options from configuration', () => {
    const options = buildBullQueueOptions({
      REDIS_URL: 'redis://:secret@redis:6380/2',
      BULL_PREFIX: 'pc',
    });
    expect(options.prefix).toBe('pc');
    expect(options.connection).toMatchObject({
      url: 'redis://:secret@redis:6380/2',
      maxRetriesPerRequest: null,
    });
    expect(options.defaultJobOptions?.attempts).toBe(3);
  });

  it('in-memory queue records jobs and de-duplicates by jobId', async () => {
    const queue = new InMemoryQueue('receipts-process');
    const first = await queue.add('process', { receiptId: 'r1' }, { jobId: 'outbox-1' });
    const duplicate = await queue.add('process', { receiptId: 'r1-again' }, { jobId: 'outbox-1' });
    await queue.add('process', { receiptId: 'r2' });
    expect(duplicate).toBe(first);
    expect(queue.jobs).toHaveLength(2);
    expect(queue.jobsNamed('process').map((job) => job.id)).toEqual(['outbox-1', '2']);
    expect(await queue.getJob('outbox-1')).toBe(first);
    expect(await queue.count()).toBe(2);
    await queue.drain();
    expect(queue.jobs).toHaveLength(0);
  });

  it('applies schedules to queues', async () => {
    const schedules = new WorkerSchedules();
    const outbox = new InMemoryQueue('outbox-dispatch');
    const expire = new InMemoryQueue('points-expire');
    const registry = {
      get: (name: string) => (name === 'outbox-dispatch' ? outbox : expire),
    } as unknown as QueueRegistry;

    schedules.register({
      id: 'outbox-dispatch',
      queue: 'outbox-dispatch',
      jobName: 'tick',
      every: 5000,
    });
    schedules.register({
      id: 'points-expire-daily',
      queue: 'points-expire',
      jobName: 'expire',
      pattern: '30 3 * * *',
    });
    // re-registering the same id for the same queue replaces the definition
    schedules.register({
      id: 'outbox-dispatch',
      queue: 'outbox-dispatch',
      jobName: 'tick',
      every: 7000,
    });

    expect(await schedules.apply(registry)).toBe(2);
    expect(outbox.schedulers.get('outbox-dispatch')?.repeat).toEqual({ every: 7000 });
    expect(expire.schedulers.get('points-expire-daily')?.repeat).toEqual({
      pattern: '30 3 * * *',
      tz: 'Europe/Kyiv',
    });
    expect(expire.schedulers.get('points-expire-daily')?.template?.name).toBe('expire');
  });

  it('validates schedule definitions', () => {
    const schedules = new WorkerSchedules();
    expect(() => schedules.register({ id: 'a', queue: 'q', jobName: 'j' })).toThrow(/exactly one/);
    expect(() =>
      schedules.register({ id: 'a', queue: 'q', jobName: 'j', every: 1000, pattern: '* * * * *' }),
    ).toThrow(/exactly one/);
    expect(() => schedules.register({ id: 'a', queue: 'q', jobName: 'j', every: 10 })).toThrow(
      /1000 ms/,
    );
    schedules.register({ id: 'a', queue: 'q', jobName: 'j', every: 1000 });
    expect(() =>
      schedules.register({ id: 'a', queue: 'other', jobName: 'j', every: 1000 }),
    ).toThrow(/already registered/);
  });
});
