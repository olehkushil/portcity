/**
 * BullMQ queue names (brief section 9). Each queue is owned by one module which registers it
 * with `QueueModule.registerQueue(QUEUES.x)` and hosts its `@Processor(QUEUES.x)`.
 */
export const QUEUES = {
  /** common/outbox: every 5 s moves unpublished outbox events into consumer queues. */
  outboxDispatch: 'outbox-dispatch',
  /** receipts: parse -> rules -> credit, 3 retries with backoff. */
  receiptsProcess: 'receipts-process',
  /** club: hourly release of pending holds. */
  pointsReleaseHolds: 'points-release-holds',
  /** club: daily 03:30 Kyiv FIFO expiry plus reminders at 30 and 7 days. */
  pointsExpire: 'points-expire',
  /** rewards: every minute, expire activations and vouchers. */
  vouchersExpire: 'vouchers-expire',
  /** notifications: consume notification.created, push via PushPort. */
  notificationsPush: 'notifications-push',
  /** parking: every 60 s sync with the provider port. */
  parkingSync: 'parking-sync',
  /** payments: hourly reconciliation of pending payments. */
  paymentsReconcile: 'payments-reconcile',
  /** admin: nightly aggregates. */
  reportsNightly: 'reports-nightly',
  /** identity: daily execution of account deletion requests. */
  accountDeletion: 'account-deletion',
  /** common/maintenance: idempotency and outbox purges. */
  maintenance: 'maintenance',
  /** content: WordPress import runs queued by POST /admin/content/import?async=true. */
  contentImport: 'content-import',
  // Outbox consumer queues (one per reacting module, brief section 3). The dispatcher adds the
  // job with name = event type, so one processor per queue switches on `job.name`.
  /** club: user.registered, user.profile_completed, receipt.credited (account, welcome bonuses). */
  clubEvents: 'club-events',
  /** rewards: event.registration_cancelled, user.deleted (vouchers of erased accounts). */
  rewardsEvents: 'rewards-events',
  /** promos: voucher.redeemed / voucher.cancelled (coupon counters, ticket registrations). */
  promosEvents: 'promos-events',
  /** parking: payment.succeeded for session payments, user.deleted (plates of erased accounts). */
  parkingEvents: 'parking-events',
  /** notifications: domain events (receipt.*, points.*, voucher.*, parking.*, payment.*) -> notifications. */
  notificationsEvents: 'notifications-events',
  /** receipts: user.deleted (receipt photos and appeal texts of erased accounts). */
  receiptsEvents: 'receipts-events',
  /** payments: user.deleted (personal data in payment meta of erased accounts). */
  paymentsEvents: 'payments-events',
  /** admin: user.deleted (support request texts and photos of erased accounts). */
  adminEvents: 'admin-events',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUES);
