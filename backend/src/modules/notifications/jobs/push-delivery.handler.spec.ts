import type { DeviceSummary } from '../../../common/contracts/identity';
import type { NotificationSummary } from '../../../common/contracts/notifications';
import type { PushSendResult } from '../domain/push-delivery.machine';
import type { PushMessage } from '../domain/push-message';
import { notificationIdOf } from './notifications-push.processor';
import {
  type PushAttemptRecord,
  type PushDeliveryRecord,
  type PushJobDeps,
  PushRetryError,
  processPushJob,
} from './push-delivery.handler';

const NOW = new Date('2026-11-01T10:00:00.000Z');

function notification(overrides: Partial<NotificationSummary> = {}): NotificationSummary {
  return {
    id: 'n1',
    userId: 'u1',
    kind: 'parking_payable',
    title: 'До сплати 60 грн',
    body: 'Оплатіть паркінг до 15:12',
    data: { sessionId: 's1', amountDueKopecks: 6000 },
    channel: 'both',
    sentAt: null,
    readAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function device(id: string, token: string | null, pushEnabled = true): DeviceSummary {
  return {
    id,
    userId: 'u1',
    platform: 'ios',
    model: null,
    appVersion: null,
    fingerprint: null,
    pushToken: token,
    pushEnabled,
    lastSeenAt: null,
  };
}

function harness(options: {
  notification?: NotificationSummary | null;
  devices?: DeviceSummary[];
  results?: Array<PushSendResult | Error>;
  existing?: PushDeliveryRecord[];
}) {
  const deliveries: PushDeliveryRecord[] = [...(options.existing ?? [])];
  const attempts: Array<{ deliveryId: string } & PushAttemptRecord> = [];
  const sent: PushMessage[] = [];
  const markedSent: string[] = [];
  const results = [...(options.results ?? [])];
  const deps: PushJobDeps = {
    now: () => NOW,
    loadNotification: async () =>
      options.notification === undefined ? notification() : options.notification,
    listPushDevices: async () => options.devices ?? [device('d1', 'token-aaaaaaaa')],
    listDeliveries: async () => deliveries.map((row) => ({ ...row })),
    createDelivery: async (input) => {
      const row: PushDeliveryRecord = {
        id: `del-${input.deviceId}`,
        deviceId: input.deviceId,
        status: 'queued',
        attempts: 0,
      };
      deliveries.push(row);
      return { ...row };
    },
    recordAttempt: async (deliveryId, attempt) => {
      attempts.push({ deliveryId, ...attempt });
      const row = deliveries.find((entry) => entry.id === deliveryId);
      if (row) {
        row.status = attempt.status;
        row.attempts += 1;
      }
    },
    markSent: async (id) => {
      markedSent.push(id);
    },
    send: async (message) => {
      sent.push(message);
      const next = results.shift() ?? { ok: true, providerMessageId: 'm1' };
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    provider: 'stub',
    maxAttempts: 3,
  };
  return { deps, deliveries, attempts, sent, markedSent };
}

describe('processPushJob (notifications-push)', () => {
  it('records one delivery per device, sends the push and marks the notification sent', async () => {
    const h = harness({
      devices: [device('d1', 'token-aaaaaaaa'), device('d2', 'token-bbbbbbbb')],
    });

    const outcome = await processPushJob({ notificationId: 'n1' }, h.deps);

    expect(outcome).toEqual({
      notificationId: 'n1',
      result: 'delivered',
      sent: 2,
      failed: 0,
      skipped: 0,
      retry: false,
    });
    expect(h.deliveries.map((row) => [row.deviceId, row.status, row.attempts])).toEqual([
      ['d1', 'sent', 1],
      ['d2', 'sent', 1],
    ]);
    expect(h.sent[0]).toMatchObject({
      token: 'token-aaaaaaaa',
      title: 'До сплати 60 грн',
      data: {
        notificationId: 'n1',
        kind: 'parking_payable',
        sessionId: 's1',
        amountDueKopecks: '6000',
      },
      collapseKey: 'parking_payable',
    });
    expect(h.attempts[0]).toMatchObject({ status: 'sent', error: null, sentAt: NOW });
    expect(h.markedSent).toEqual(['n1']);
  });

  it('skips devices without push, duplicate tokens and in-app only notifications', async () => {
    const devices = [
      device('d1', 'token-aaaaaaaa'),
      device('d2', 'token-aaaaaaaa'),
      device('d3', null),
      device('d4', 'token-cccccccc', false),
    ];
    const h = harness({ devices });
    await processPushJob({ notificationId: 'n1' }, h.deps);
    expect(h.deliveries.map((row) => row.deviceId)).toEqual(['d1']);

    const inapp = harness({ notification: notification({ channel: 'inapp' }) });
    await expect(processPushJob({ notificationId: 'n1' }, inapp.deps)).resolves.toMatchObject({
      result: 'inapp_only',
    });
    expect(inapp.sent).toHaveLength(0);
    expect(inapp.markedSent).toEqual(['n1']);
  });

  it('marks a notification without push devices as sent (nothing to push)', async () => {
    const h = harness({ devices: [] });
    await expect(processPushJob({ notificationId: 'n1' }, h.deps)).resolves.toMatchObject({
      result: 'no_devices',
    });
    expect(h.markedSent).toEqual(['n1']);
  });

  it('returns missing for an unknown notification', async () => {
    const h = harness({ notification: null });
    await expect(processPushJob({ notificationId: 'nx' }, h.deps)).resolves.toMatchObject({
      result: 'missing',
    });
  });

  it('records permanent failures without retrying and leaves sentAt empty', async () => {
    const h = harness({
      results: [{ ok: false, code: 'unregistered', retryable: false, message: 'token gone' }],
    });
    const outcome = await processPushJob({ notificationId: 'n1' }, h.deps);
    expect(outcome).toMatchObject({ result: 'failed', failed: 1, retry: false });
    expect(h.attempts[0]).toMatchObject({ status: 'failed', error: 'unregistered: token gone' });
    expect(h.markedSent).toEqual([]);
  });

  it('throws PushRetryError on transient failures and resends only the failed device later', async () => {
    const h = harness({
      devices: [device('d1', 'token-aaaaaaaa'), device('d2', 'token-bbbbbbbb')],
      results: [{ ok: true, providerMessageId: 'm1' }, new Error('ECONNRESET')],
    });

    const error = await processPushJob({ notificationId: 'n1' }, h.deps).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PushRetryError);
    expect((error as PushRetryError).outcome).toMatchObject({
      result: 'partial',
      sent: 1,
      failed: 1,
      retry: true,
    });
    expect(h.attempts[1]).toMatchObject({ status: 'failed', error: 'provider_error: ECONNRESET' });
    expect(h.markedSent).toEqual(['n1']);

    const retry = await processPushJob({ notificationId: 'n1' }, h.deps);
    expect(h.sent.map((message) => message.token)).toEqual([
      'token-aaaaaaaa',
      'token-bbbbbbbb',
      'token-bbbbbbbb',
    ]);
    expect(retry).toMatchObject({ result: 'delivered', sent: 1 });
    expect(h.deliveries.find((row) => row.deviceId === 'd2')).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
  });

  it('gives up after maxAttempts', async () => {
    const h = harness({
      existing: [{ id: 'del-d1', deviceId: 'd1', status: 'failed', attempts: 3 }],
    });
    await expect(processPushJob({ notificationId: 'n1' }, h.deps)).resolves.toMatchObject({
      result: 'nothing_to_do',
    });
    expect(h.sent).toHaveLength(0);
  });

  it('marks deliveries skipped when the provider is not configured', async () => {
    const h = harness({
      results: [{ ok: false, code: 'not_configured', retryable: false, message: 'FCM disabled' }],
    });
    await expect(processPushJob({ notificationId: 'n1' }, h.deps)).resolves.toMatchObject({
      result: 'skipped',
      skipped: 1,
    });
    expect(h.deliveries[0]?.status).toBe('skipped');
    expect(h.markedSent).toEqual(['n1']);
  });
});

describe('notificationIdOf', () => {
  it('reads the id from a notification.created outbox job or a manual job', () => {
    expect(notificationIdOf({ eventId: 'e', payload: { notificationId: 'n1' } })).toBe('n1');
    expect(notificationIdOf({ notificationId: 'n2' })).toBe('n2');
    expect(() => notificationIdOf({ payload: {} })).toThrow('carries no notificationId');
    expect(() => notificationIdOf(null)).toThrow('carries no notificationId');
  });
});
