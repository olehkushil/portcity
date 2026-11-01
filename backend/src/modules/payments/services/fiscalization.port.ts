import type { PaymentProvider, PaymentPurpose } from '../../../common/contracts/payments';
import type { Kopecks } from '../../../common/contracts/shared';

export interface FiscalizationInput {
  paymentId: string;
  userId: string;
  purpose: PaymentPurpose;
  amountKopecks: Kopecks;
  currency: string;
  description: string;
  provider: PaymentProvider;
  providerRef: string | null;
  paidAt: Date;
}

export type FiscalizationResult =
  /** Nothing to do: fiscalisation is handled elsewhere (provider auto-fiscalisation, legal exception). */
  | { kind: 'skipped'; reason: string }
  /** A fiscal receipt exists; the payment moves to `fiscalized`. */
  | { kind: 'fiscalized'; fiscalReceiptUrl: string | null; fiscalRef: string | null };

/**
 * Fiscalisation hook (brief section 2 "fiscalisation hook", plan section 8: provider
 * auto-fiscalisation preferred, a PRRO adapter such as Checkbox or Vchasno.Kasa optional).
 * Called after `payment.succeeded`; adapters: NoopFiscalizationAdapter, MockFiscalizationAdapter.
 * The abstract class doubles as the Nest injection token.
 */
export abstract class FiscalizationPort {
  abstract readonly name: string;
  abstract fiscalize(input: FiscalizationInput): Promise<FiscalizationResult>;
}

export class NoopFiscalizationAdapter extends FiscalizationPort {
  readonly name = 'none';

  async fiscalize(): Promise<FiscalizationResult> {
    return { kind: 'skipped', reason: 'PAYMENTS_FISCALIZATION=none' };
  }
}

/** Development adapter: pretends a PRRO issued a receipt and links a fake receipt URL. */
export class MockFiscalizationAdapter extends FiscalizationPort {
  readonly name = 'mock';
  private counter = 0;

  constructor(private readonly receiptBaseUrl: string) {
    super();
  }

  async fiscalize(input: FiscalizationInput): Promise<FiscalizationResult> {
    this.counter += 1;
    const base = this.receiptBaseUrl.replace(/\/+$/, '');
    return {
      kind: 'fiscalized',
      fiscalReceiptUrl: `${base}/${encodeURIComponent(input.paymentId)}`,
      fiscalRef: `mock-fiscal-${this.counter}`,
    };
  }
}
