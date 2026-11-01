import type { DeviceSummary } from '../../../common/contracts/identity';
import type {
  NotificationSummary,
  PushDeliveryStatus,
} from '../../../common/contracts/notifications';
import { needsPush, selectPushTargets } from '../domain/delivery-policy';
import {
  type PushSendResult,
  deliveryStatusAfter,
  planDeliveryAttempt,
  shouldRetryDelivery,
} from '../domain/push-delivery.machine';
import { type PushMessage, buildPushMessage } from '../domain/push-message';

export interface PushDeliveryRecord {
  id: string;
  deviceId: string;
  status: PushDeliveryStatus;
  attempts: number;
}

export interface PushAttemptRecord {
  status: PushDeliveryStatus;
  error: string | null;
  sentAt: Date | null;
}

export interface PushJobDeps {
  now(): Date;
  loadNotification(notificationId: string): Promise<NotificationSummary | null>;
  listPushDevices(userId: string): Promise<DeviceSummary[]>;
  listDeliveries(notificationId: string): Promise<PushDeliveryRecord[]>;
  createDelivery(input: {
    notificationId: string;
    deviceId: string;
    provider: string;
  }): Promise<PushDeliveryRecord>;
  /** Persists one attempt: new status, error text, sentAt; increments `attempts`. */
  recordAttempt(deliveryId: string, attempt: PushAttemptRecord): Promise<void>;
  /** Sets Notification.sentAt when still null. */
  markSent(notificationId: string, at: Date): Promise<void>;
  send(message: PushMessage): Promise<PushSendResult>;
  provider: string;
  maxAttempts: number;
  log?: (message: string) => void;
}

export type PushJobResult =
  | 'missing'
  | 'inapp_only'
  | 'no_devices'
  | 'delivered'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'nothing_to_do';

export interface PushJobOutcome {
  notificationId: string;
  result: PushJobResult;
  sent: number;
  failed: number;
  skipped: number;
  /** True when the job threw PushRetryError so the queue retries it. */
  retry: boolean;
}

/** Thrown when at least one delivery failed transiently and may still be retried. */
export class PushRetryError extends Error {
  constructor(readonly outcome: PushJobOutcome) {
    super(
      `Push delivery for notification ${outcome.notificationId} needs a retry (${outcome.failed} transient failure(s))`,
    );
    this.name = 'PushRetryError';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handler of the notifications-push job (brief section 9): one PushDelivery row per device,
 * idempotent per (notification, device) so a retried job skips what was already sent.
 * Notification.sentAt is set when at least one push went out or there was nothing to push;
 * permanent failures leave it null and the delivery rows explain why.
 */
export async function processPushJob(
  input: { notificationId: string },
  deps: PushJobDeps,
): Promise<PushJobOutcome> {
  const outcome: PushJobOutcome = {
    notificationId: input.notificationId,
    result: 'missing',
    sent: 0,
    failed: 0,
    skipped: 0,
    retry: false,
  };
  const notification = await deps.loadNotification(input.notificationId);
  if (!notification) {
    deps.log?.(`push job: notification ${input.notificationId} not found`);
    return outcome;
  }
  if (!needsPush(notification.channel)) {
    if (!notification.sentAt) {
      await deps.markSent(notification.id, deps.now());
    }
    outcome.result = 'inapp_only';
    return outcome;
  }

  const targets = selectPushTargets(await deps.listPushDevices(notification.userId));
  if (targets.length === 0) {
    await deps.markSent(notification.id, deps.now());
    outcome.result = 'no_devices';
    return outcome;
  }

  const existing = new Map(
    (await deps.listDeliveries(notification.id)).map((row) => [row.deviceId, row]),
  );
  let attempted = 0;
  let retry = false;
  for (const device of targets) {
    const token = device.pushToken ?? '';
    const current = existing.get(device.id) ?? null;
    if (planDeliveryAttempt(current, deps.maxAttempts) !== 'send') {
      continue;
    }
    const delivery =
      current ??
      (await deps.createDelivery({
        notificationId: notification.id,
        deviceId: device.id,
        provider: deps.provider,
      }));
    attempted += 1;

    let result: PushSendResult;
    try {
      result = await deps.send(buildPushMessage(notification, token));
    } catch (error) {
      result = { ok: false, code: 'provider_error', retryable: true, message: describe(error) };
    }
    const status = deliveryStatusAfter(result);
    const attemptsAfter = delivery.attempts + 1;
    await deps.recordAttempt(delivery.id, {
      status,
      error: result.ok ? null : `${result.code}: ${result.message}`,
      sentAt: result.ok ? deps.now() : null,
    });
    if (status === 'sent') {
      outcome.sent += 1;
    } else if (status === 'skipped') {
      outcome.skipped += 1;
    } else {
      outcome.failed += 1;
    }
    if (shouldRetryDelivery(result, attemptsAfter, deps.maxAttempts)) {
      retry = true;
    }
  }

  if (attempted === 0) {
    outcome.result = 'nothing_to_do';
  } else if (outcome.sent === attempted) {
    outcome.result = 'delivered';
  } else if (outcome.sent > 0) {
    outcome.result = 'partial';
  } else if (outcome.failed > 0) {
    outcome.result = 'failed';
  } else {
    outcome.result = 'skipped';
  }
  if (outcome.sent > 0 || outcome.result === 'nothing_to_do' || outcome.result === 'skipped') {
    await deps.markSent(notification.id, deps.now());
  }
  deps.log?.(
    `push job ${notification.id} (${notification.kind}): ${outcome.result}, sent ${outcome.sent}, failed ${outcome.failed}, skipped ${outcome.skipped}`,
  );
  if (retry) {
    outcome.retry = true;
    throw new PushRetryError(outcome);
  }
  return outcome;
}
