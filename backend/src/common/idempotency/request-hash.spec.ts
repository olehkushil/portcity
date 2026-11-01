import { IDEMPOTENCY_KEY_PATTERN, canonicalJson, computeRequestHash } from './request-hash';

describe('idempotency request hashing', () => {
  it('canonicalises objects independent of key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,2]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(new Date('2026-01-01T00:00:00Z'))).toBe('"2026-01-01T00:00:00.000Z"');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ n: 10n, inf: Number.POSITIVE_INFINITY })).toBe('{"inf":null,"n":"10"}');
  });

  it('is stable for equivalent requests', () => {
    const first = computeRequestHash({
      method: 'post',
      path: '/api/v1/receipts/qr',
      body: { qrText: 'abc', meta: { b: 2, a: 1 } },
    });
    const second = computeRequestHash({
      method: 'POST',
      path: '/api/v1/receipts/qr',
      body: { meta: { a: 1, b: 2 }, qrText: 'abc' },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the body, method or path change', () => {
    const base = { method: 'POST', path: '/api/v1/rewards/1/redeem', body: { points: 40 } };
    const hash = computeRequestHash(base);
    expect(computeRequestHash({ ...base, body: { points: 41 } })).not.toBe(hash);
    expect(computeRequestHash({ ...base, method: 'PUT' })).not.toBe(hash);
    expect(computeRequestHash({ ...base, path: '/api/v1/rewards/2/redeem' })).not.toBe(hash);
    expect(computeRequestHash({ ...base, body: { points: [40] } })).not.toBe(hash);
  });

  it('treats a missing body and an empty body consistently', () => {
    const noBody = computeRequestHash({ method: 'POST', path: '/x' });
    expect(computeRequestHash({ method: 'POST', path: '/x', body: undefined })).toBe(noBody);
    expect(computeRequestHash({ method: 'POST', path: '/x', body: null })).toBe(noBody);
    expect(computeRequestHash({ method: 'POST', path: '/x', body: {} })).not.toBe(noBody);
  });

  it('validates key format', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('order:2026-01-15:42')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('short')).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('has space 1234')).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('x'.repeat(129))).toBe(false);
  });
});
