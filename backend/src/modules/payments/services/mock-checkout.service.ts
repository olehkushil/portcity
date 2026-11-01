import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { formatUah } from '../../../common/money/money';
import { PaymentErrors } from '../domain/errors';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments.config';
import { type WebhookAck, PaymentWebhooksService } from './payment-webhooks.service';
import { PaymentsService } from './payments.service';
import { type MockCheckoutState, MockPaymentProvider } from './providers/mock-payment-provider';

/** What the customer can do on the mock hosted checkout page. */
export const MOCK_CHECKOUT_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;
export type MockCheckoutOutcome = (typeof MOCK_CHECKOUT_OUTCOMES)[number];

export interface MockCheckoutView {
  providerRef: string;
  paymentId: string;
  amountKopecks: number;
  currency: string;
  description: string;
  status: MockCheckoutState['status'];
}

export interface MockCheckoutResult {
  providerRef: string;
  paymentId: string;
  outcome: MockCheckoutOutcome;
  /** What the webhook endpoint answered for the simulated provider callback. */
  webhook: WebhookAck;
  /** Where a real provider would redirect the customer (deep link back into the app). */
  returnUrl: string;
}

/** Stable event id per checkout and outcome: a repeated click is a duplicate webhook, not a new one. */
export function mockCheckoutEventId(providerRef: string, outcome: MockCheckoutOutcome): string {
  return `mock-checkout:${providerRef}:${outcome}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const OUTCOME_LABELS: Record<MockCheckoutOutcome, string> = {
  succeeded: 'Оплатити',
  failed: 'Картку відхилено',
  cancelled: 'Скасувати',
};

/**
 * Development stand-in for the provider's hosted checkout page (the `checkoutUrl` the mock adapter
 * returns). Completing it settles the in-memory mock checkout and delivers a correctly signed
 * webhook through the same PaymentWebhooksService a real callback would hit, so the whole
 * created -> pending -> succeeded (or failed / cancelled) path works without a real acquirer.
 * Disabled (404) in production or when another provider is configured.
 */
@Injectable()
export class MockCheckoutService {
  constructor(
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    private readonly mock: MockPaymentProvider,
    private readonly webhooks: PaymentWebhooksService,
    private readonly payments: PaymentsService,
  ) {}

  get enabled(): boolean {
    return this.config.NODE_ENV !== 'production' && this.config.PAYMENTS_PROVIDER === 'mock';
  }

  view(providerRef: string): MockCheckoutView {
    const state = this.requireCheckout(providerRef);
    return {
      providerRef,
      paymentId: state.paymentId,
      amountKopecks: state.amountKopecks,
      currency: state.currency,
      description: state.description,
      status: state.status,
    };
  }

  /** Minimal HTML page with one form per outcome (no scripts, works under the default helmet CSP). */
  renderPage(providerRef: string): string {
    const view = this.view(providerRef);
    const action = `${encodeURIComponent(providerRef)}/complete`;
    const open = view.status === 'pending';
    const buttons = open
      ? MOCK_CHECKOUT_OUTCOMES.map(
          (outcome) =>
            `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="outcome" value="${outcome}"><button type="submit">${OUTCOME_LABELS[outcome]}</button></form>`,
        ).join('\n')
      : `<p>Оплату вже завершено: ${escapeHtml(view.status)}</p>`;
    return [
      '<!doctype html>',
      '<html lang="uk"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>PortCity: тестова оплата</title></head>',
      '<body style="font-family: sans-serif; max-width: 420px; margin: 32px auto; padding: 0 16px">',
      '<h1>Тестова оплата</h1>',
      '<p>Сторінка мок-провайдера для розробки. Реальні гроші не списуються.</p>',
      `<p><strong>${escapeHtml(formatUah(view.amountKopecks))}</strong></p>`,
      `<p>${escapeHtml(view.description)}</p>`,
      `<p><small>Платіж ${escapeHtml(view.paymentId)}</small></p>`,
      buttons,
      '</body></html>',
    ].join('\n');
  }

  /** Settles the mock checkout and delivers the signed webhook; idempotent per outcome. */
  async complete(
    providerRef: string,
    outcome: MockCheckoutOutcome,
    failureCode?: string,
  ): Promise<MockCheckoutResult> {
    const state = this.requireCheckout(providerRef);
    if (state.status !== 'pending' && state.status !== outcome) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_INVALID_TRANSITION,
        `Mock checkout ${providerRef} is already ${state.status}`,
        { details: { providerRef, status: state.status, requested: outcome } },
      );
    }
    if (state.status === 'pending') {
      this.mock.settle(providerRef, outcome, failureCode);
    }
    const webhook = this.mock.buildWebhook(providerRef, mockCheckoutEventId(providerRef, outcome));
    // Same path as a real callback: the body is serialised once and signed as those bytes.
    const ack = await this.webhooks.handle(this.mock.name, {
      headers: webhook.headers,
      body: webhook.body,
      rawBody: webhook.rawBody,
    });
    const detail = await this.payments.getAdminDetail(state.paymentId);
    return {
      providerRef,
      paymentId: state.paymentId,
      outcome,
      webhook: ack,
      returnUrl: detail.internal.returnUrl ?? this.config.PAYMENTS_RETURN_URL,
    };
  }

  private requireCheckout(providerRef: string): MockCheckoutState {
    if (!this.enabled) {
      throw new DomainError(CommonErrors.PC_COMMON_NOT_FOUND, 'Mock checkout is disabled', {
        details: { providerRef },
      });
    }
    const state = this.mock.getCheckout(providerRef);
    if (!state) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_NOT_FOUND,
        `Mock checkout ${providerRef} does not exist (mock state lives in the API process memory)`,
        { details: { providerRef } },
      );
    }
    return state;
  }
}
