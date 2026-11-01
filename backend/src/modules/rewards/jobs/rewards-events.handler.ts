import { IDENTITY_EVENTS, PROMO_EVENTS } from '../../../common/contracts/events';
import { QUEUES } from '../../../common/queue/queue.constants';
import type { LiveVoucherFilter } from '../services/rewards.repository';
import type { SystemCancelResult } from '../services/voucher.service';

/**
 * Outbox events consumed on the `rewards-events` queue (job name = event type):
 * - `event.registration_cancelled`: the ticket voucher of the registration is cancelled (no
 *   points involved). Promos normally cancels it synchronously; this is the safety net for
 *   cancellations that did not reach the voucher (idempotent: final vouchers are skipped).
 * - `user.deleted`: every live voucher of the anonymised account is cancelled without refund.
 */
export const REWARDS_HANDLED_EVENTS = [
  PROMO_EVENTS.eventRegistrationCancelled,
  IDENTITY_EVENTS.deleted,
] as const;

export const REWARDS_OUTBOX_ROUTES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(REWARDS_HANDLED_EVENTS.map((type) => [type, QUEUES.rewardsEvents])),
);

export interface RewardsEventsDeps {
  cancelVoucher(
    voucherId: string,
    reason: string,
    refundPoints: boolean,
  ): Promise<SystemCancelResult>;
  cancelLiveVouchers(
    filter: LiveVoucherFilter,
    reason: string,
    refundPoints: boolean,
  ): Promise<number>;
  log?: (message: string) => void;
}

export type RewardsEventAction = 'cancelled' | 'skipped' | 'missing' | 'ignored';

export interface RewardsEventOutcome {
  type: string;
  action: RewardsEventAction;
  /** Vouchers cancelled by this event. */
  cancelled: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts the outbox job data (`{ eventId, type, payload, ... }`) or a bare payload. */
function payloadOf(data: unknown): Record<string, unknown> {
  if (isRecord(data) && isRecord(data['payload'])) {
    return data['payload'];
  }
  return isRecord(data) ? data : {};
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Handler logic of the rewards-events processor; plain function, unit tested. */
export async function handleRewardsEventJob(
  name: string,
  data: unknown,
  deps: RewardsEventsDeps,
): Promise<RewardsEventOutcome> {
  const payload = payloadOf(data);
  switch (name) {
    case PROMO_EVENTS.eventRegistrationCancelled: {
      const voucherId = stringField(payload, 'voucherId');
      if (!voucherId) {
        return { type: name, action: 'ignored', cancelled: 0 };
      }
      const result = await deps.cancelVoucher(voucherId, 'Event registration cancelled', false);
      return { type: name, action: result, cancelled: result === 'cancelled' ? 1 : 0 };
    }
    case IDENTITY_EVENTS.deleted: {
      const userId = stringField(payload, 'userId');
      if (!userId) {
        deps.log?.(`rewards-events: ${name} without userId ignored`);
        return { type: name, action: 'ignored', cancelled: 0 };
      }
      const cancelled = await deps.cancelLiveVouchers({ userId }, 'Account deleted', false);
      return { type: name, action: cancelled > 0 ? 'cancelled' : 'skipped', cancelled };
    }
    default:
      deps.log?.(`rewards-events: no handler for "${name}", ignored`);
      return { type: name, action: 'ignored', cancelled: 0 };
  }
}
