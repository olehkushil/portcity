import { PAYMENT_PROVIDERS, type PaymentProvider } from '../../../../common/contracts/payments';
import { DomainError } from '../../../../common/errors/domain-error';
import { PaymentErrors } from '../../domain/errors';
import type { PaymentProviderPort } from '../payment-provider.port';

export function isPaymentProviderName(value: unknown): value is PaymentProvider {
  return typeof value === 'string' && (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Resolves provider adapters by name: the default one for new payments (PAYMENTS_PROVIDER)
 * and any configured one for webhooks (`POST /webhooks/payments/:provider`) and for
 * reconciling payments created under a previous provider.
 */
export class PaymentProviderRegistry {
  private readonly adapters = new Map<PaymentProvider, PaymentProviderPort>();
  readonly default: PaymentProviderPort;

  constructor(adapters: readonly PaymentProviderPort[], defaultName: PaymentProvider) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.name, adapter);
    }
    const chosen = this.adapters.get(defaultName);
    if (!chosen) {
      throw new Error(
        `PAYMENTS_PROVIDER=${defaultName} has no adapter; available: ${[...this.adapters.keys()].join(', ') || 'none'}`,
      );
    }
    this.default = chosen;
  }

  /** Throws `PC_PAYMENT_PROVIDER_UNKNOWN` (404) for names without an adapter. */
  get(name: string): PaymentProviderPort {
    const adapter = isPaymentProviderName(name) ? this.adapters.get(name) : undefined;
    if (!adapter) {
      throw new DomainError(
        PaymentErrors.PC_PAYMENT_PROVIDER_UNKNOWN,
        `Payment provider "${name}" is not configured`,
        { details: { provider: name, available: this.names() } },
      );
    }
    return adapter;
  }

  tryGet(name: string): PaymentProviderPort | undefined {
    return isPaymentProviderName(name) ? this.adapters.get(name) : undefined;
  }

  names(): PaymentProvider[] {
    return [...this.adapters.keys()];
  }
}
