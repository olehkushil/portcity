import { Injectable } from '@nestjs/common';
import type { TaxCheckStatus } from '../domain/rules';

/** What the checker gets: the canonical receipt identifiers and the scanned QR text. */
export interface TaxReceiptCheckInput {
  receiptId: string;
  fn: string;
  fiscalId: string;
  issuedAt: Date;
  totalKopecks: number;
  /** `mac` parameter of offline receipts, when the QR had one. */
  mac: string | null;
  rawQr: string | null;
}

export interface TaxReceiptCheckResult {
  status: TaxCheckStatus;
  /** Short technical note for the receipt history (never shown to the member). */
  detail?: string;
}

/**
 * Authenticity check of a fiscal receipt against the tax service (ДПС). The tax service has no
 * public API for this and the QR `mac` cannot be verified offline, so the default adapter answers
 * `unknown` and the module relies on the verification hold and the fraud patterns instead. A
 * real adapter (an agreement with ДПС, a fiscal data operator, or a scraper of the receipt page)
 * plugs in here: `confirmed` releases a receipt from the hold logic, `rejected` sends it to
 * moderation during the decision and reverses its pending points during the hold.
 *
 * The abstract class doubles as the Nest injection token. Implementations must not throw for
 * "cannot tell": they answer `unknown`; thrown errors are logged and treated as `unknown`.
 */
export abstract class TaxReceiptVerifierPort {
  abstract verify(input: TaxReceiptCheckInput): Promise<TaxReceiptCheckResult>;
}

/** Default adapter: no checker is available, every receipt is `unknown`. */
@Injectable()
export class NoopTaxReceiptVerifier extends TaxReceiptVerifierPort {
  verify(): Promise<TaxReceiptCheckResult> {
    return Promise.resolve({ status: 'unknown', detail: 'no tax checker configured' });
  }
}
