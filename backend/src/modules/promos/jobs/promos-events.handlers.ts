import {
  REWARD_EVENTS,
  type VoucherCancelledPayload,
  type VoucherRedeemedPayload,
} from '../../../common/contracts/events';

/** Job names on QUEUES.promosEvents besides the outbox event types. */
export const PROMOS_JOBS = {
  finishEvents: 'promos-finish-events',
} as const;

export type RegistrationOutcome = 'used' | 'cancelled' | 'not_found' | 'already_final';

/** Outcome of cancelling a coupon claim (see PromosService.cancelCouponClaim). */
export type CouponClaimOutcome = 'coupon_released' | 'already_cancelled' | 'not_found';

/** Everything the handler needs; the processor wires it to services, tests pass fakes. */
export interface PromosEventsDeps {
  now(): Date;
  markRegistrationUsed(voucherId: string): Promise<RegistrationOutcome>;
  cancelRegistrationByVoucher(voucherId: string, reason: string): Promise<RegistrationOutcome>;
  /** `claimId` is the coupon voucher's sourceId (a coupon_claims row). */
  cancelCouponClaim(claimId: string): Promise<CouponClaimOutcome>;
  finishDueEvents(now: Date): Promise<number>;
}

export interface PromosJobOutcome {
  job: string;
  action: string;
  details?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Outbox job data as produced by the dispatcher (`Job<OutboxJobData>`), loosely typed on purpose. */
function payloadOf(data: unknown): Record<string, unknown> {
  if (isRecord(data) && isRecord(data.payload)) {
    return data.payload;
  }
  return {};
}

function ignored(job: string, reason: string, details?: Record<string, unknown>): PromosJobOutcome {
  return { job, action: 'ignored', details: { reason, ...details } };
}

export async function handleVoucherRedeemed(
  payload: Partial<VoucherRedeemedPayload>,
  deps: PromosEventsDeps,
): Promise<PromosJobOutcome> {
  const job = REWARD_EVENTS.voucherRedeemed;
  if (payload.kind !== 'ticket' || payload.sourceType !== 'event' || !payload.voucherId) {
    return ignored(job, 'not a ticket', { kind: payload.kind, sourceType: payload.sourceType });
  }
  const outcome = await deps.markRegistrationUsed(payload.voucherId);
  return { job, action: outcome, details: { voucherId: payload.voucherId } };
}

export async function handleVoucherCancelled(
  payload: Partial<VoucherCancelledPayload>,
  deps: PromosEventsDeps,
): Promise<PromosJobOutcome> {
  const job = REWARD_EVENTS.voucherCancelled;
  if (!payload.voucherId) {
    return ignored(job, 'missing voucherId');
  }
  if (payload.kind === 'ticket' && payload.sourceType === 'event') {
    const outcome = await deps.cancelRegistrationByVoucher(
      payload.voucherId,
      `Ticket cancelled: ${payload.reason ?? 'no reason given'}`,
    );
    return { job, action: outcome, details: { voucherId: payload.voucherId } };
  }
  if (payload.kind === 'coupon' && payload.sourceType === 'promo') {
    if (!payload.sourceId) {
      return ignored(job, 'coupon without a claim id (sourceId)', {
        voucherId: payload.voucherId,
      });
    }
    const outcome = await deps.cancelCouponClaim(payload.sourceId);
    return {
      job,
      action: outcome,
      details: { voucherId: payload.voucherId, claimId: payload.sourceId },
    };
  }
  return ignored(job, 'not a coupon or ticket', {
    kind: payload.kind,
    sourceType: payload.sourceType,
  });
}

export async function handleFinishEvents(deps: PromosEventsDeps): Promise<PromosJobOutcome> {
  const finished = await deps.finishDueEvents(deps.now());
  return { job: PROMOS_JOBS.finishEvents, action: 'finished', details: { count: finished } };
}

/** Plain handler logic for QUEUES.promosEvents (brief section 9: processors only wire). */
export async function handlePromosEventsJob(
  name: string,
  data: unknown,
  deps: PromosEventsDeps,
): Promise<PromosJobOutcome> {
  switch (name) {
    case REWARD_EVENTS.voucherRedeemed:
      return handleVoucherRedeemed(payloadOf(data), deps);
    case REWARD_EVENTS.voucherCancelled:
      return handleVoucherCancelled(payloadOf(data), deps);
    case PROMOS_JOBS.finishEvents:
      return handleFinishEvents(deps);
    default:
      throw new Error(`Unknown promos job "${name}"`);
  }
}
