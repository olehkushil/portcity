import { ALL_OUTBOX_EVENT_TYPES, IDENTITY_EVENTS } from '../../src/common/contracts/events';
import { AUDIT_ONLY_OUTBOX_EVENTS } from '../../src/common/outbox/audit-only-events';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { QueueRegistry } from '../../src/common/queue/queue-registry.service';
import { createTestApp, type TestApp } from '../utils/app-factory';

/**
 * Integration guard for the outbox catalogue: with the full AppModule booted, every event type
 * a module may publish either reaches at least one consumer queue (registered by the consuming
 * module in onModuleInit) or is declared audit-only, so the dispatcher never drops an event as
 * unrouted.
 */
describe('outbox routes (e2e)', () => {
  let testApp: TestApp;
  let router: OutboxRouter;

  beforeAll(async () => {
    testApp = await createTestApp();
    router = testApp.app.get(OutboxRouter);
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('routes or explicitly ignores every catalogue event type', () => {
    const unhandled = ALL_OUTBOX_EVENT_TYPES.filter(
      (type) => router.resolve(type).length === 0 && !router.isIgnored(type),
    );
    expect(unhandled).toEqual([]);
  });

  it('does not keep audit-only entries for events that now have a consumer', () => {
    const stale = Object.keys(AUDIT_ONLY_OUTBOX_EVENTS).filter(
      (type) => router.resolve(type).length > 0,
    );
    expect(stale).toEqual([]);
  });

  it('only routes to queues that are registered', () => {
    const queues = testApp.app.get(QueueRegistry);
    const missing = router
      .list()
      .map((route) => route.queue)
      .filter((queue) => queues.tryGet(queue) === undefined);
    expect(missing).toEqual([]);
  });

  it('delivers user.deleted to every module that holds personal data', () => {
    expect(router.resolve(IDENTITY_EVENTS.deleted).sort()).toEqual(
      [
        'admin-events',
        'notifications-events',
        'parking-events',
        'payments-events',
        'receipts-events',
        'rewards-events',
      ].sort(),
    );
  });
});
