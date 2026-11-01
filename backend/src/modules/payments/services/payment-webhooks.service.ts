import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Payment } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import type { PaymentProvider, PaymentStatus } from '../../../common/contracts/payments';
import { DomainError } from '../../../common/errors/domain-error';
import { toJsonValue } from '../../../common/idempotency/idempotency.service';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { PaymentErrors } from '../domain/errors';
import type { ProviderPaymentEvent } from '../domain/provider-events';
import { webhookPolicyViolation } from '../domain/webhook-policy';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments.config';
import type { ProviderWebhookRequest } from './payment-provider.port';
import { looksLikeUuid } from './payment.mapper';
import { type ApplyOutcome, PaymentsService, describeOutcome } from './payments.service';
import { PaymentProviderRegistry } from './providers/provider.registry';

export interface WebhookAck {
  received: true;
  /** `processed`: status changed; `duplicate`: seen before or no change; `ignored`: stale or conflicting. */
  result: 'processed' | 'duplicate' | 'ignored';
  paymentId: string | null;
  status: PaymentStatus | null;
  detail: string;
}

/**
 * `POST /webhooks/payments/:provider` (brief section 8): the adapter verifies the signature,
 * the `(provider, externalId)` unique key of payment_webhook_logs makes replays no-ops, and
 * the status change is applied under the payment row lock in the same transaction as the log
 * row and the outbox event. A callback for an unknown payment answers 404 so the provider
 * retries later (the payment row may still be committing).
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger(PaymentWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly providers: PaymentProviderRegistry,
    private readonly payments: PaymentsService,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {}

  async handle(providerName: string, request: ProviderWebhookRequest): Promise<WebhookAck> {
    const provider = this.providers.get(providerName);
    const event = provider.parseWebhook(request);
    const providerEnum = provider.name;

    // Real acquirers: a success must state amount and currency, a timestamped notification must
    // be fresh (replay protection). Checked before any database work.
    const violation = webhookPolicyViolation(event, {
      strict: provider.strictWebhooks,
      maxAgeSeconds: this.config.PAYMENTS_WEBHOOK_MAX_AGE_SECONDS,
      now: this.clock.now(),
    });
    if (violation) {
      this.logger.warn(
        `Rejecting webhook ${event.externalId} from ${provider.name}: ${violation.reason} (${violation.detail})`,
      );
      throw new DomainError(
        violation.reason === 'stale'
          ? PaymentErrors.PC_PAYMENT_WEBHOOK_STALE
          : PaymentErrors.PC_PAYMENT_WEBHOOK_MALFORMED,
        violation.detail,
        { details: { provider: provider.name, reason: violation.reason } },
      );
    }

    const seen = await this.prisma.paymentWebhookLog.findUnique({
      where: { provider_externalId: { provider: providerEnum, externalId: event.externalId } },
    });
    if (seen) {
      return {
        received: true,
        result: 'duplicate',
        paymentId: seen.paymentId,
        status: null,
        detail: seen.result ?? 'already received',
      };
    }

    const payment = await this.locatePayment(providerEnum, event);
    if (!payment) {
      this.logger.warn(
        `Webhook ${event.externalId} from ${provider.name} references unknown payment (ref ${event.providerRef}, id ${event.paymentId ?? '-'})`,
      );
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_NOT_FOUND,
        'No payment matches this provider reference',
        { details: { provider: provider.name, providerRef: event.providerRef } },
      );
    }

    let outcome: ApplyOutcome;
    try {
      outcome = await this.prisma.withTx(async (tx) => {
        const log = await tx.paymentWebhookLog.create({
          data: {
            id: uuidv7(),
            provider: providerEnum,
            externalId: event.externalId,
            paymentId: payment.id,
            payload: toJsonValue(event.raw),
            receivedAt: this.clock.now(),
          },
        });
        const applied = await this.payments.applyProviderEventInTx(
          tx,
          payment.id,
          event,
          'webhook',
        );
        await tx.paymentWebhookLog.update({
          where: { id: log.id },
          data: { processedAt: this.clock.now(), result: describeOutcome(applied) },
        });
        return applied;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent delivery of the same notification won the race.
        return {
          received: true,
          result: 'duplicate',
          paymentId: payment.id,
          status: null,
          detail: 'concurrent duplicate',
        };
      }
      throw error;
    }

    await this.payments.followUp(outcome);
    return {
      received: true,
      result:
        outcome.kind === 'transitioned'
          ? 'processed'
          : outcome.kind === 'noop'
            ? 'duplicate'
            : 'ignored',
      paymentId: outcome.paymentId,
      status: outcome.payment.status,
      detail: describeOutcome(outcome),
    };
  }

  /** Our id echoed by the provider wins; otherwise the provider reference under that provider. */
  private async locatePayment(
    provider: PaymentProvider,
    event: ProviderPaymentEvent,
  ): Promise<Payment | null> {
    if (looksLikeUuid(event.paymentId)) {
      const byId = await this.prisma.payment.findUnique({ where: { id: event.paymentId } });
      if (byId && byId.provider === provider) {
        return byId;
      }
    }
    return this.prisma.payment.findFirst({
      where: { provider, providerRef: event.providerRef },
      orderBy: { createdAt: 'desc' },
    });
  }
}
