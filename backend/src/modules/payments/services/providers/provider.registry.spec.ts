import type { PaymentProvider } from '../../../../common/contracts/payments';
import type { PaymentProviderPort } from '../payment-provider.port';
import { PaymentProviderRegistry, isPaymentProviderName } from './provider.registry';

function adapter(name: PaymentProvider): PaymentProviderPort {
  return { name } as PaymentProviderPort;
}

describe('PaymentProviderRegistry', () => {
  it('resolves the default and named adapters', () => {
    const mock = adapter('mock');
    const liqpay = adapter('liqpay');
    const registry = new PaymentProviderRegistry([mock, liqpay], 'liqpay');
    expect(registry.default).toBe(liqpay);
    expect(registry.get('mock')).toBe(mock);
    expect(registry.tryGet('mock')).toBe(mock);
    expect(registry.names()).toEqual(['mock', 'liqpay']);
  });

  it('fails fast when the configured default has no adapter', () => {
    expect(() => new PaymentProviderRegistry([adapter('mock')], 'mono')).toThrow(
      'PAYMENTS_PROVIDER=mono has no adapter; available: mock',
    );
  });

  it('answers 404 PC_PAYMENT_PROVIDER_UNKNOWN for unknown names', () => {
    const registry = new PaymentProviderRegistry([adapter('mock')], 'mock');
    let caught: unknown;
    try {
      registry.get('paypal');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'PC_PAYMENT_PROVIDER_UNKNOWN',
      status: 404,
      details: { provider: 'paypal', available: ['mock'] },
    });
    expect(registry.tryGet('fondy')).toBeUndefined();
    expect(registry.tryGet('../etc')).toBeUndefined();
  });

  it('recognises provider names from the contract', () => {
    expect(isPaymentProviderName('wayforpay')).toBe(true);
    expect(isPaymentProviderName('stripe')).toBe(false);
    expect(isPaymentProviderName(undefined)).toBe(false);
  });
});
