import type { ProviderPaymentEvent } from './provider-events';

export interface WebhookPolicy {
  /**
   * Real acquirer adapters are strict: success notifications must state the captured amount
   * and currency, and timestamped notifications must be fresh. The development mock is lenient.
   */
  strict: boolean;
  maxAgeSeconds: number;
  now: Date;
}

export type WebhookPolicyViolation =
  | { reason: 'amount_missing' | 'currency_missing'; detail: string }
  | { reason: 'stale'; detail: string };

/**
 * Pure check of a parsed provider notification before any database work (finding: webhook
 * strictness). Returns null when the event may be processed.
 */
export function webhookPolicyViolation(
  event: Pick<ProviderPaymentEvent, 'kind' | 'amountKopecks' | 'currency' | 'occurredAt'>,
  policy: WebhookPolicy,
): WebhookPolicyViolation | null {
  if (!policy.strict) {
    return null;
  }
  if (event.kind === 'succeeded') {
    if (event.amountKopecks === undefined || event.amountKopecks === null) {
      return { reason: 'amount_missing', detail: 'success notifications must state the amount' };
    }
    if (!event.currency) {
      return {
        reason: 'currency_missing',
        detail: 'success notifications must state the currency',
      };
    }
  }
  if (event.occurredAt) {
    const ageMs = policy.now.getTime() - event.occurredAt.getTime();
    const limitMs = policy.maxAgeSeconds * 1000;
    if (Math.abs(ageMs) > limitMs) {
      return {
        reason: 'stale',
        detail:
          ageMs > 0
            ? `notification is ${Math.round(ageMs / 1000)} s old (limit ${policy.maxAgeSeconds} s)`
            : `notification is dated ${Math.round(-ageMs / 1000)} s in the future (limit ${policy.maxAgeSeconds} s)`,
      };
    }
  }
  return null;
}
