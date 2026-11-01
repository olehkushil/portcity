import type { NotificationSummary } from '../../../common/contracts/notifications';

/** Provider-neutral push payload; `data` values are strings because FCM requires it. */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Lets the device replace an older unread push of the same kind. */
  collapseKey?: string;
}

/** FCM limits the whole data map to 4 KB; keep every value short. */
export const MAX_PUSH_DATA_VALUE_LENGTH = 512;

export function buildPushMessage(notification: NotificationSummary, token: string): PushMessage {
  const data: Record<string, string> = { notificationId: notification.id, kind: notification.kind };
  for (const [key, value] of Object.entries(notification.data)) {
    if (value === null || value === undefined || key === 'notificationId' || key === 'kind') {
      continue;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text !== undefined) {
      data[key] = text.slice(0, MAX_PUSH_DATA_VALUE_LENGTH);
    }
  }
  return {
    token,
    title: notification.title,
    body: notification.body,
    data,
    collapseKey: notification.kind,
  };
}
