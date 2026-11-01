import { NOTIFICATION_EVENTS } from '../../../common/contracts/events';
import { QUEUES } from '../../../common/queue/queue.constants';
import { HANDLED_EVENT_TYPES } from '../domain/event-mapper';

/**
 * Outbox routes registered by NotificationsModule.onModuleInit():
 * `notification.created` feeds the push queue, every handled domain event feeds the
 * notifications-events queue.
 */
export const NOTIFICATION_OUTBOX_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  [NOTIFICATION_EVENTS.created]: QUEUES.notificationsPush,
  ...Object.fromEntries(HANDLED_EVENT_TYPES.map((type) => [type, QUEUES.notificationsEvents])),
});
