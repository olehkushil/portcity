import { FakeNotificationsPrisma } from '../../../../test/notifications/support/fake-notifications-prisma';
import type { AdminAuditPort, AuditEntry } from '../../../common/contracts/admin';
import type { DeviceSummary, IdentityPort, UserSummary } from '../../../common/contracts/identity';
import type { OutboxEventInput } from '../../../common/outbox/outbox.types';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { notificationsEnvSchema } from './notifications.config';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsService } from './notifications.service';
import { PushDeliveryService } from './push-delivery.service';
import { StubPushAdapter } from './push/stub-push.adapter';

const USER = '01900000-0000-7000-8000-000000000001';
const BLOCKED = '01900000-0000-7000-8000-000000000002';

function user(id: string, status: UserSummary['status'] = 'active'): UserSummary {
  return {
    id,
    phone: '+380501234567',
    email: null,
    firstName: 'Олег',
    lastName: null,
    birthDate: null,
    status,
    memberCode: '734211800',
    profileCompletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
  };
}

function device(id: string, token: string): DeviceSummary {
  return {
    id,
    userId: USER,
    platform: 'android',
    model: 'Pixel',
    appVersion: '1.0.0',
    fingerprint: null,
    pushToken: token,
    pushEnabled: true,
    lastSeenAt: null,
  };
}

function setup(options: { marketingConsent?: boolean } = {}) {
  const clock = new FakeClock('2026-11-01T10:00:00.000Z');
  const prisma = new FakeNotificationsPrisma(() => clock.now());
  const db = prisma as unknown as PrismaService;
  const events: OutboxEventInput[] = [];
  const outbox = {
    publish: async (_tx: unknown, event: OutboxEventInput) => {
      events.push(event);
      return 'evt';
    },
  } as unknown as OutboxService;
  const identity = {
    getUser: jest.fn(async (id: string) =>
      id === USER ? user(USER) : id === BLOCKED ? user(BLOCKED, 'blocked') : null,
    ),
    getUsers: jest.fn(),
    getDevice: jest.fn(),
    resolveMemberCode: jest.fn(),
    listPushDevices: jest.fn(async () => [
      device('d1', 'token-aaaaaaaa'),
      device('d2', 'token-bbbbbbbb'),
    ]),
    hasConsent: jest.fn(async () => options.marketingConsent ?? false),
  } as unknown as IdentityPort;
  const audits: Array<{ entry: AuditEntry; tx: unknown }> = [];
  const audit: AdminAuditPort = {
    audit: async (entry, tx) => {
      audits.push({ entry, tx });
      return 'audit';
    },
  };
  const preferences = new NotificationPreferencesService(db, clock);
  const notifications = new NotificationsService(db, clock, outbox, preferences, identity, audit);
  const push = new StubPushAdapter();
  const config = notificationsEnvSchema.parse({});
  const deliveries = new PushDeliveryService(db, clock, notifications, push, identity, config);
  return { clock, prisma, events, audits, identity, preferences, notifications, push, deliveries };
}

describe('NotificationsService (NOTIFICATIONS_PORT)', () => {
  it('stores the notification and publishes notification.created for the push queue', async () => {
    const s = setup();

    const created = await s.notifications.notify({
      userId: USER,
      kind: 'receipt_credited',
      title: '  Нараховано 18 балів  ',
      body: 'Чек на 600 грн зараховано',
      data: { receiptId: 'r1' },
      dedupeKey: 'outbox:evt-1',
    });

    expect(created).toMatchObject({
      userId: USER,
      kind: 'receipt_credited',
      title: 'Нараховано 18 балів',
      channel: 'both',
      sentAt: null,
      readAt: null,
      data: { receiptId: 'r1' },
    });
    expect(s.prisma.notifications[0]?.data).toMatchObject({ receiptId: 'r1' });
    expect(s.events).toEqual([
      expect.objectContaining({
        type: 'notification.created',
        aggregateId: created?.id,
        payload: {
          notificationId: created?.id,
          userId: USER,
          kind: 'receipt_credited',
          channel: 'both',
        },
      }),
    ]);
  });

  it('returns the existing notification on a replay of the dedupe key', async () => {
    const s = setup();
    const input = {
      userId: USER,
      kind: 'points_released' as const,
      title: 'Бали доступні',
      body: '150 балів',
      dedupeKey: 'outbox:evt-2',
    };
    const first = await s.notifications.createNotification(input);
    const replay = await s.notifications.createNotification(input);
    expect(first.status).toBe('created');
    expect(replay).toMatchObject({
      status: 'replayed',
      notification: { id: first.notification?.id },
    });
    expect(s.prisma.notifications).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it('keeps the dedupe key in its own column, not in data', async () => {
    const s = setup();
    await s.notifications.notify({
      userId: USER,
      kind: 'points_released',
      title: 'Бали доступні',
      body: '150 балів',
      data: { txId: 't1', _dedupeKey: 'spoofed' },
      dedupeKey: 'outbox:evt-9',
    });
    expect(s.prisma.notifications[0]).toMatchObject({
      dedupeKey: 'outbox:evt-9',
      data: { txId: 't1' },
    });
    expect(s.prisma.notifications[0]?.data).not.toHaveProperty('_dedupeKey');
  });

  it('turns a lost insert race on the dedupe key into a replay without a second event', async () => {
    const s = setup();
    const input = {
      userId: USER,
      kind: 'points_released' as const,
      title: 'Бали доступні',
      body: '150 балів',
      dedupeKey: 'outbox:evt-3',
    };
    // The concurrent delivery committed between our lookup and our insert.
    const findFirst = s.prisma.notification.findFirst;
    let lookups = 0;
    s.prisma.notification.findFirst = async (args) => {
      lookups += 1;
      if (lookups === 1) {
        await s.prisma.notification.create({
          data: { ...input, id: 'winner', channel: 'both', createdAt: s.clock.now() },
        });
        return null;
      }
      return findFirst(args);
    };
    const result = await s.notifications.createNotification(input);
    expect(result).toMatchObject({ status: 'replayed', notification: { id: 'winner' } });
    expect(s.prisma.notifications).toHaveLength(1);
    expect(s.events).toHaveLength(0);
  });

  it('erases the inbox, push deliveries and preferences of a deleted member', async () => {
    const s = setup();
    const created = await s.notifications.notify({
      userId: USER,
      kind: 'receipt_credited',
      title: 'Нараховано',
      body: 'Чек',
    });
    await s.deliveries.deliver(created!.id);
    await s.preferences.update(USER, [{ kind: 'parking_payable', enabled: false }]);
    expect(s.prisma.deliveries.length).toBeGreaterThan(0);

    expect(await s.notifications.eraseUserData(USER)).toEqual({ notifications: 1, preferences: 1 });
    expect(s.prisma.notifications).toEqual([]);
    expect(s.prisma.deliveries).toEqual([]);
    expect(s.prisma.preferences).toEqual([]);
    expect(await s.notifications.eraseUserData(USER)).toEqual({ notifications: 0, preferences: 0 });
  });

  it('stores in-app only kinds as already sent', async () => {
    const s = setup();
    const created = await s.notifications.notify({
      userId: USER,
      kind: 'points_expired',
      title: 'Бали згоріли',
      body: '40 балів',
    });
    expect(created).toMatchObject({
      channel: 'inapp',
      sentAt: new Date('2026-11-01T10:00:00.000Z'),
    });
  });

  it.each([
    [{ userId: BLOCKED, kind: 'receipt_credited' as const }, 'user_inactive'],
    [
      { userId: '01900000-0000-7000-8000-00000000ffff', kind: 'receipt_credited' as const },
      'user_missing',
    ],
    [{ userId: USER, kind: 'promo_published' as const }, 'consent_missing'],
  ])('skips %j: %s', async (target, reason) => {
    const s = setup();
    const result = await s.notifications.createNotification({ ...target, title: 't', body: 'b' });
    expect(result).toEqual({ status: 'skipped', reason, notification: null });
    expect(s.prisma.notifications).toHaveLength(0);
    expect(s.events).toHaveLength(0);
  });

  it('delivers marketing kinds only with the marketing consent', async () => {
    const s = setup({ marketingConsent: true });
    const created = await s.notifications.notify({
      userId: USER,
      kind: 'promo_published',
      title: 'Нова акція',
      body: '-20 %',
    });
    expect(created?.kind).toBe('promo_published');
    expect(s.identity.hasConsent).toHaveBeenCalledWith(USER, 'marketing');
  });

  it('respects a disabled preference and rejects unknown kinds', async () => {
    const s = setup();
    await s.preferences.update(USER, [{ kind: 'parking_payable', enabled: false }]);
    await expect(
      s.notifications.notify({ userId: USER, kind: 'parking_payable', title: 't', body: 'b' }),
    ).resolves.toBeNull();
    await expect(
      s.notifications.notify({ userId: USER, kind: 'nonsense' as never, title: 't', body: 'b' }),
    ).rejects.toMatchObject({ code: 'PC_NOTIFICATION_KIND_UNKNOWN', status: 400 });
  });

  it('lists the inbox newest first, counts unread and marks rows read idempotently', async () => {
    const s = setup();
    const first = await s.notifications.notify({
      userId: USER,
      kind: 'receipt_credited',
      title: '1',
      body: '1',
    });
    s.clock.advanceMinutes(1);
    const second = await s.notifications.notify({
      userId: USER,
      kind: 'receipt_credited',
      title: '2',
      body: '2',
    });

    const page = await s.notifications.list(USER, { limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual([second?.id]);
    expect(page.nextCursor).not.toBeNull();
    const next = await s.notifications.list(USER, {
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    });
    expect(next.items.map((item) => item.id)).toEqual([first?.id]);

    await expect(s.notifications.countUnread(USER)).resolves.toBe(2);
    const read = await s.notifications.markRead(USER, first?.id ?? '');
    s.clock.advanceMinutes(5);
    const again = await s.notifications.markRead(USER, first?.id ?? '');
    expect(again.readAt).toEqual(read.readAt);
    await expect(s.notifications.markAllRead(USER)).resolves.toBe(1);
    await expect(s.notifications.countUnread(USER)).resolves.toBe(0);
  });

  it('sends an admin notification and its audit row in one transaction', async () => {
    const s = setup();
    const sent = await s.notifications.sendAsAdmin(
      {
        userId: USER,
        kind: 'system',
        title: 'Технічні роботи',
        body: 'Паркінг недоступний до 12:00',
      },
      { id: 'admin-1', ip: '10.0.0.5' },
      'Звернення в підтримку',
    );
    expect(sent.status).toBe('created');
    expect(s.audits).toEqual([
      {
        entry: expect.objectContaining({
          actor: { type: 'admin', id: 'admin-1' },
          action: 'notification.send',
          entityType: 'notification',
          entityId: sent.notification?.id,
          reason: 'Звернення в підтримку',
          ip: '10.0.0.5',
        }),
        tx: s.prisma,
      },
    ]);

    const skipped = await s.notifications.sendAsAdmin(
      { userId: BLOCKED, kind: 'system', title: 't', body: 'b' },
      { id: 'admin-1' },
      null,
    );
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'user_inactive' });
    expect(s.audits[1]?.entry).toMatchObject({
      entityId: null,
      after: expect.objectContaining({ status: 'skipped', skippedReason: 'user_inactive' }),
    });
  });

  it("hides another member's notification behind 404", async () => {
    const s = setup();
    const created = await s.notifications.notify({
      userId: USER,
      kind: 'receipt_credited',
      title: 't',
      body: 'b',
    });
    await expect(s.notifications.markRead(BLOCKED, created?.id ?? '')).rejects.toMatchObject({
      code: 'PC_NOTIFICATION_NOT_FOUND',
      status: 404,
    });
  });
});

describe('PushDeliveryService (records push deliveries)', () => {
  it('sends through the push port and records one delivery row per device', async () => {
    const s = setup();
    const created = await s.notifications.notify({
      userId: USER,
      kind: 'parking_payable',
      title: 'До сплати 60 грн',
      body: 'Оплатіть до 15:12',
      data: { sessionId: 's1' },
    });

    const outcome = await s.deliveries.deliver(created?.id ?? '');

    expect(outcome).toMatchObject({ result: 'delivered', sent: 2 });
    expect(s.push.sent.map((message) => message.token)).toEqual([
      'token-aaaaaaaa',
      'token-bbbbbbbb',
    ]);
    expect(
      s.prisma.deliveries.map((row) => [row.deviceId, row.provider, row.status, row.attempts]),
    ).toEqual([
      ['d1', 'stub', 'sent', 1],
      ['d2', 'stub', 'sent', 1],
    ]);
    expect(s.prisma.notifications[0]?.sentAt).toEqual(new Date('2026-11-01T10:00:00.000Z'));
    await expect(s.notifications.listDeliveries(created?.id ?? '')).resolves.toHaveLength(2);
  });

  it('keeps the failure on the delivery row', async () => {
    const s = setup();
    const created = await s.notifications.notify({
      userId: USER,
      kind: 'parking_paid',
      title: 't',
      body: 'b',
    });
    s.push.failNext(
      { ok: false, code: 'invalid_token', retryable: false, message: 'bad token' },
      { ok: true, providerMessageId: 'm2' },
    );
    const outcome = await s.deliveries.deliver(created?.id ?? '');
    expect(outcome).toMatchObject({ result: 'partial', sent: 1, failed: 1 });
    expect(s.prisma.deliveries[0]).toMatchObject({
      status: 'failed',
      error: 'invalid_token: bad token',
    });
  });
});

describe('NotificationPreferencesService', () => {
  it('lists every kind enabled by default and locks service kinds', async () => {
    const s = setup();
    const all = await s.preferences.getAll(USER);
    expect(all.every((entry) => entry.enabled)).toBe(true);
    expect(all.find((entry) => entry.kind === 'payment_failed')).toMatchObject({ locked: true });
    expect(all.find((entry) => entry.kind === 'parking_payable')).toMatchObject({ locked: false });
  });

  it('updates kinds (last entry wins) and refuses locked or unknown kinds', async () => {
    const s = setup();
    const updated = await s.preferences.update(USER, [
      { kind: 'voucher_issued', enabled: false },
      { kind: 'voucher_issued', enabled: true },
      { kind: 'points_expiring', enabled: false },
    ]);
    expect(updated.find((entry) => entry.kind === 'voucher_issued')?.enabled).toBe(true);
    expect(updated.find((entry) => entry.kind === 'points_expiring')?.enabled).toBe(false);
    await expect(
      s.preferences.update(USER, [{ kind: 'payment_failed', enabled: false }]),
    ).rejects.toMatchObject({ code: 'PC_NOTIFICATION_PREFERENCE_LOCKED', status: 422 });
    await expect(
      s.preferences.update(USER, [{ kind: 'nope', enabled: true }]),
    ).rejects.toMatchObject({
      code: 'PC_NOTIFICATION_KIND_UNKNOWN',
    });
  });
});
