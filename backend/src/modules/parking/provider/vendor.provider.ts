import { DomainError } from '../../../common/errors/domain-error';
import { ParkingErrors } from '../domain/errors';
import {
  ParkingProviderPort,
  type ProviderPaymentRegistration,
  type ProviderSessionSnapshot,
  type ProviderVerificationRequest,
  type ProviderVerificationResult,
  type ProviderWebhookEvent,
  type ProviderWebhookRequest,
} from './parking-provider.port';

export const VENDOR_PROVIDER_NAME = 'vendor';

export interface VendorProviderOptions {
  /** Operator API base URL (unknown until the Discovery phase picks the vendor). */
  baseUrl: string | null;
  apiKey: string | null;
  webhookSecret: string;
}

/**
 * Placeholder for the parking operator's real system (PARKING_PROVIDER=vendor). The operator,
 * its API and its webhook format are not chosen yet (design brief section 9, item 2), so every
 * call answers PC_PARKING_PROVIDER_UNAVAILABLE: the app degrades to the info-mode timer and the
 * paymat, exactly as it does when a real operator API is down. Replace the method bodies once the
 * vendor's API is known; the rest of the module only talks to ParkingProviderPort.
 */
export class VendorParkingProvider extends ParkingProviderPort {
  readonly name = VENDOR_PROVIDER_NAME;

  constructor(private readonly options: VendorProviderOptions) {
    super();
  }

  get configured(): boolean {
    return Boolean(this.options.baseUrl && this.options.apiKey);
  }

  async listActiveSessions(): Promise<ProviderSessionSnapshot[]> {
    throw this.unavailable('listActiveSessions');
  }

  async findSessionByPlate(_plate: string): Promise<ProviderSessionSnapshot | null> {
    throw this.unavailable('findSessionByPlate');
  }

  async getSessionByRef(_providerRef: string): Promise<ProviderSessionSnapshot | null> {
    throw this.unavailable('getSessionByRef');
  }

  async findSessionByTalon(_talonCode: string): Promise<ProviderSessionSnapshot | null> {
    throw this.unavailable('findSessionByTalon');
  }

  async registerPayment(_input: ProviderPaymentRegistration): Promise<void> {
    throw this.unavailable('registerPayment');
  }

  async verifyVehicle(_input: ProviderVerificationRequest): Promise<ProviderVerificationResult> {
    throw this.unavailable('verifyVehicle');
  }

  parseWebhook(_request: ProviderWebhookRequest): ProviderWebhookEvent {
    throw this.unavailable('parseWebhook');
  }

  private unavailable(operation: string): DomainError {
    return new DomainError(
      ParkingErrors.PC_PARKING_PROVIDER_UNAVAILABLE,
      `Parking operator integration is not implemented yet (${operation})`,
      { details: { provider: VENDOR_PROVIDER_NAME, operation, configured: this.configured } },
    );
  }
}
