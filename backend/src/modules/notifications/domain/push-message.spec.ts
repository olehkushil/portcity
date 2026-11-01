import type { NotificationSummary } from '../../../common/contracts/notifications';
import { MAX_PUSH_DATA_VALUE_LENGTH, buildPushMessage } from './push-message';

const notification: NotificationSummary = {
  id: 'n-1',
  userId: 'u-1',
  kind: 'receipt_credited',
  title: 'Бали нараховано',
  body: 'Чек прийнято',
  data: { receiptId: 'r-1', points: 180, nested: { a: 1 }, empty: null, kind: 'ignored' },
  channel: 'both',
  sentAt: null,
  readAt: null,
  createdAt: new Date('2026-03-01T10:00:00Z'),
};

describe('buildPushMessage', () => {
  it('stringifies data values and adds the notification id and kind', () => {
    const message = buildPushMessage(notification, 'tok-1');
    expect(message).toEqual({
      token: 'tok-1',
      title: 'Бали нараховано',
      body: 'Чек прийнято',
      collapseKey: 'receipt_credited',
      data: {
        notificationId: 'n-1',
        kind: 'receipt_credited',
        receiptId: 'r-1',
        points: '180',
        nested: '{"a":1}',
      },
    });
  });

  it('truncates long values', () => {
    const message = buildPushMessage(
      { ...notification, data: { note: 'x'.repeat(MAX_PUSH_DATA_VALUE_LENGTH + 10) } },
      'tok-1',
    );
    expect(message.data.note?.length).toBe(MAX_PUSH_DATA_VALUE_LENGTH);
  });
});
