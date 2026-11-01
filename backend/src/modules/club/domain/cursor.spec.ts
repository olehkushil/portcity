import { decodeTransactionCursor, encodeTransactionCursor } from './cursor';
import { expiryKey, reversalKey } from './ledger-keys';

describe('transaction cursor', () => {
  it('round-trips createdAt and id', () => {
    const cursor = {
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
      id: '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11',
    };
    const encoded = encodeTransactionCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTransactionCursor(encoded)).toEqual(cursor);
  });

  it('returns undefined for an absent cursor', () => {
    expect(decodeTransactionCursor(undefined)).toBeUndefined();
    expect(decodeTransactionCursor('')).toBeUndefined();
  });

  it.each([
    ['not base64 json', 'definitely-not-a-cursor'],
    ['wrong shape', Buffer.from(JSON.stringify({ foo: 1 })).toString('base64url')],
    ['bad date', Buffer.from(JSON.stringify({ c: 'yesterday', i: 'x' })).toString('base64url')],
  ])('rejects %s with PC_COMMON_CURSOR_INVALID', (_name, raw) => {
    let error: unknown;
    try {
      decodeTransactionCursor(raw);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'PC_COMMON_CURSOR_INVALID' });
  });
});

describe('derived ledger keys', () => {
  it('are stable and distinct', () => {
    expect(reversalKey('tx-1')).toBe('reverse:tx-1');
    expect(expiryKey('acc-1', '2027-01-15')).toBe('expire:acc-1:2027-01-15');
    expect(reversalKey('a')).not.toBe(expiryKey('a', 'b'));
  });
});
