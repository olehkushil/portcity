import {
  type FiscalizationInput,
  MockFiscalizationAdapter,
  NoopFiscalizationAdapter,
} from './fiscalization.port';

const input: FiscalizationInput = {
  paymentId: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
  userId: 'user-1',
  purpose: 'parking',
  amountKopecks: 6000,
  currency: 'UAH',
  description: 'Parking',
  provider: 'mock',
  providerRef: 'mock_1',
  paidAt: new Date('2026-01-15T10:00:00Z'),
};

describe('fiscalisation adapters', () => {
  it('noop adapter skips and says why', async () => {
    const adapter = new NoopFiscalizationAdapter();
    expect(adapter.name).toBe('none');
    await expect(adapter.fiscalize()).resolves.toEqual({
      kind: 'skipped',
      reason: 'PAYMENTS_FISCALIZATION=none',
    });
  });

  it('mock adapter issues sequential fake receipts', async () => {
    const adapter = new MockFiscalizationAdapter('http://localhost:3000/mock-fiscal/');
    expect(adapter.name).toBe('mock');
    await expect(adapter.fiscalize(input)).resolves.toEqual({
      kind: 'fiscalized',
      fiscalReceiptUrl: 'http://localhost:3000/mock-fiscal/0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
      fiscalRef: 'mock-fiscal-1',
    });
    await expect(adapter.fiscalize(input)).resolves.toMatchObject({ fiscalRef: 'mock-fiscal-2' });
  });
});
