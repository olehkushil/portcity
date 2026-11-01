import { InMemoryQueue } from '../../../common/queue/in-memory-queue';
import { FakeClock } from '../../../common/time/clock';
import { REMINDER_JOBS, type ReminderRequest } from '../domain/reminders';
import { ReminderScheduler } from './reminder-scheduler.service';

function request(runAt: string): ReminderRequest {
  return {
    id: 'ticket-reminder-reg-1',
    jobName: REMINDER_JOBS.ticket,
    runAt: new Date(runAt),
    data: {
      userId: 'u1',
      eventId: 'e1',
      registrationId: 'reg-1',
      voucherId: null,
      startsAt: '2026-11-07T13:00:00.000Z',
    },
  };
}

describe('ReminderScheduler', () => {
  it('adds a delayed job with a stable id once and cancels it', async () => {
    const queue = new InMemoryQueue('notifications-events');
    const scheduler = new ReminderScheduler(queue, new FakeClock('2026-11-01T10:00:00.000Z'));

    await expect(scheduler.schedule(request('2026-11-06T13:00:00.000Z'))).resolves.toBe(true);
    await scheduler.schedule(request('2026-11-06T13:00:00.000Z'));

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({
      id: 'ticket-reminder-reg-1',
      name: 'reminder.ticket',
      opts: { jobId: 'ticket-reminder-reg-1', delay: 442_800_000, removeOnComplete: true },
    });

    await expect(scheduler.cancel('ticket-reminder-reg-1')).resolves.toBe(true);
    await expect(scheduler.cancel('ticket-reminder-reg-1')).resolves.toBe(false);
    expect(queue.jobs).toHaveLength(0);
  });

  it('does not schedule reminders whose time has passed', async () => {
    const queue = new InMemoryQueue('notifications-events');
    const scheduler = new ReminderScheduler(queue, new FakeClock('2026-11-01T10:00:00.000Z'));
    await expect(scheduler.schedule(request('2026-11-01T09:59:00.000Z'))).resolves.toBe(false);
    expect(queue.jobs).toHaveLength(0);
  });
});
