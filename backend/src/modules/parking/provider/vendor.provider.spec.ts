import { DomainError } from '../../../common/errors/domain-error';
import { VendorParkingProvider } from './vendor.provider';

describe('VendorParkingProvider (stub)', () => {
  const provider = new VendorParkingProvider({
    baseUrl: null,
    apiKey: null,
    webhookSecret: 'secret-secret',
  });

  const expectUnavailable = async (call: () => Promise<unknown>): Promise<void> => {
    await expect(call()).rejects.toMatchObject({
      code: 'PC_PARKING_PROVIDER_UNAVAILABLE',
      status: 503,
    });
  };

  it('answers 503 for every operator call until the API is integrated', async () => {
    await expectUnavailable(() => provider.listActiveSessions());
    await expectUnavailable(() => provider.findSessionByPlate('AC1234BC'));
    await expectUnavailable(() => provider.getSessionByRef('ref'));
    await expectUnavailable(() => provider.findSessionByTalon('PC-0418227'));
    await expectUnavailable(() =>
      provider.registerPayment({
        providerRef: 'ref',
        paymentId: 'p',
        amountKopecks: 100,
        paidUntil: new Date(),
      }),
    );
    await expectUnavailable(() => provider.verifyVehicle({ plate: 'AC1234BC', talonCode: '1234' }));
  });

  it('rejects webhooks with the same error', () => {
    try {
      provider.parseWebhook({ body: {}, headers: {} });
      throw new Error('expected a DomainError');
    } catch (error) {
      expect(DomainError.is(error)).toBe(true);
      expect((error as DomainError).code).toBe('PC_PARKING_PROVIDER_UNAVAILABLE');
    }
  });

  it('reports whether credentials are configured', () => {
    expect(provider.name).toBe('vendor');
    expect(provider.configured).toBe(false);
    expect(
      new VendorParkingProvider({ baseUrl: 'https://x', apiKey: 'k', webhookSecret: 's' })
        .configured,
    ).toBe(true);
  });
});
