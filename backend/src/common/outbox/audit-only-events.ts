import type { OutboxEventType } from '../contracts/events';

/**
 * Outbox event types that no module consumes on purpose. They stay in the outbox table as a
 * fact log (and in the catalogue, so a consumer can subscribe later); the dispatcher marks them
 * published immediately instead of retrying them as unrouted. A consumer that later registers
 * a route for one of these types takes precedence automatically; remove the entry then
 * (test/e2e/outbox-routes.e2e-spec.ts fails while a type is both routed and listed here).
 */
export const AUDIT_ONLY_OUTBOX_EVENTS: Readonly<Partial<Record<OutboxEventType, string>>> =
  Object.freeze({
    'user.device_registered': 'push devices are read through IDENTITY_PORT when a push is sent',
    'user.blocked': 'identity revokes the sessions itself; no other module keeps per-user state',
    'user.unblocked': 'nothing was suspended outside identity, so nothing has to be restored',
    'points.account_created': 'the welcome bonus is a separate points.credited row',
    'points.credited':
      'member-facing facts travel in receipt.credited and adjustment.applied; the ledger is the source of truth',
    'points.held': 'receipt.credited with pointsState = pending carries the facts for the member',
    'points.spent': 'redemption.created and voucher.issued describe the spend for the member',
    'points.reversed': 'voucher.cancelled carries the refund; reversals are visible in the ledger',
    'tenant.updated': 'no cross-module cache of tenants exists yet',
    'tenant.fiscal_number_seen':
      'moderators work from GET /admin/fiscal-numbers?status=pending; the event is the audit trail',
    'tenant.fiscal_number_confirmed': 'receipts read the whitelist through CONTENT_PORT on demand',
    'receipt.submitted':
      'audit trail; the outcome events (credited, needs_moderation, rejected) follow',
    'receipt.approved': 'always followed by receipt.credited, which notifies the member',
    'receipt.appealed': 'the moderation queue lists appealed receipts directly',
    'redemption.created': 'voucher.issued notifies the member about the new voucher',
    'voucher.activated': 'the app shows the activation code itself; no side effect elsewhere',
    'promo.coupon_claimed': 'voucher.issued notifies the member about the coupon',
    'parking.vehicle.verified': 'parking links the sessions itself during verification',
    'parking.payment.ops_alert':
      'ops alert log: also logged at error level and written to the audit log (entityType payment); no consumer yet',
    'payment.created': 'the purpose module created the payment synchronously',
    'payment.cancelled': 'the member cancelled in the checkout and sees it there',
    'payment.expired': 'abandoned checkout; the parking session stays payable',
    'payment.fiscalized': 'the fiscal receipt URL is read through GET /payments/:id',
    'adjustment.requested': 'back-office workflow; approvers work from GET /admin/adjustments',
    'adjustment.approved': 'followed by adjustment.applied, which notifies the member',
    'adjustment.rejected': 'back-office decision; the member was not told about the request',
    'flag.updated': 'FeatureFlagsService re-reads flags every 5 s; no cache to invalidate',
  });
