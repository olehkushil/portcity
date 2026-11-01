import { erasePersonalMeta, neutralDescription } from './erasure';

describe('erasePersonalMeta', () => {
  const parkingMeta = {
    sessionId: 's-1',
    paidUntil: '2026-01-15T14:00:00.000Z',
    plate: 'AC1234BC',
    providerRef: 'op-1',
    _internal: {
      description: 'Паркінг Порт City, AC 1234 BC, виїзд до 16:00, 60 ₴',
      returnUrl: 'portcity://payments/return',
      refunds: [{ kopecks: 100 }],
    },
  };

  it.each([
    [
      'parking meta: plate removed, description neutral, business context kept',
      parkingMeta,
      'parking',
      {
        sessionId: 's-1',
        paidUntil: '2026-01-15T14:00:00.000Z',
        providerRef: 'op-1',
        _internal: {
          description: 'Паркінг Порт City',
          returnUrl: 'portcity://payments/return',
          refunds: [{ kopecks: 100 }],
        },
      },
      true,
    ],
    [
      'other personal keys at both levels',
      { email: 'a@b.c', phone: '+380', orderId: 'o-1', _internal: { name: 'Олег' } },
      'other',
      { orderId: 'o-1', _internal: {} },
      true,
    ],
    ['nothing personal', { sessionId: 's-2' }, 'parking', { sessionId: 's-2' }, false],
    ['not an object', null, 'other', {}, false],
  ])('%s', (_name, meta, purpose, expected, changed) => {
    expect(erasePersonalMeta(meta, purpose)).toEqual({ meta: expected, changed });
  });

  it('is idempotent', () => {
    const once = erasePersonalMeta(parkingMeta, 'parking');
    const twice = erasePersonalMeta(once.meta, 'parking');
    expect(twice).toEqual({ meta: once.meta, changed: false });
  });

  it('uses a neutral description per purpose', () => {
    expect(neutralDescription('parking')).toBe('Паркінг Порт City');
    expect(neutralDescription('other')).toBe('Платіж Порт City');
  });
});
