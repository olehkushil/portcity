import { JwtError, decodeJwtUnsafe, signJwtHs256, verifyJwtHs256 } from './jwt';

describe('HS256 JWT', () => {
  const secret = 'unit-test-secret-0123456789abcdef';
  const now = new Date('2026-01-15T10:00:00Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);

  function expectFailure(fn: () => unknown, reason: string): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(JwtError);
      expect((error as JwtError).reason).toBe(reason);
      return;
    }
    throw new Error(`expected JwtError(${reason})`);
  }

  it('signs and verifies a token', () => {
    const token = signJwtHs256(
      { sub: 'user-1', typ: 'member', iat: nowSeconds, exp: nowSeconds + 900, iss: 'portcity' },
      secret,
    );
    expect(token.split('.')).toHaveLength(3);
    const claims = verifyJwtHs256(token, secret, { now, issuer: 'portcity' });
    expect(claims.sub).toBe('user-1');
    expect(claims['typ']).toBe('member');
    expect(decodeJwtUnsafe(token)?.header).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('rejects wrong secrets and tampered payloads', () => {
    const token = signJwtHs256({ sub: 'user-1', exp: nowSeconds + 900 }, secret);
    expectFailure(() => verifyJwtHs256(token, 'other-secret', { now }), 'invalid_signature');

    const [header, , signature] = token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url');
    expectFailure(
      () => verifyJwtHs256(`${header}.${forgedPayload}.${signature}`, secret, { now }),
      'invalid_signature',
    );
  });

  it('rejects expired and not-yet-valid tokens, honouring tolerance', () => {
    const expired = signJwtHs256({ sub: 'u', exp: nowSeconds - 1 }, secret);
    expectFailure(() => verifyJwtHs256(expired, secret, { now }), 'expired');
    expect(() => verifyJwtHs256(expired, secret, { now, clockToleranceSeconds: 5 })).not.toThrow();

    const future = signJwtHs256({ sub: 'u', nbf: nowSeconds + 60 }, secret);
    expectFailure(() => verifyJwtHs256(future, secret, { now }), 'not_yet_valid');
  });

  it('rejects malformed tokens and foreign algorithms', () => {
    expectFailure(() => verifyJwtHs256('abc', secret), 'malformed');
    expectFailure(() => verifyJwtHs256('a..c', secret), 'malformed');
    expectFailure(() => verifyJwtHs256('!!.!!.!!', secret), 'malformed');

    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    const payload = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url');
    expectFailure(
      () => verifyJwtHs256(`${noneHeader}.${payload}.x`, secret),
      'unsupported_algorithm',
    );
  });

  it('checks the issuer when requested', () => {
    const token = signJwtHs256({ sub: 'u', iss: 'someone-else' }, secret);
    expectFailure(() => verifyJwtHs256(token, secret, { issuer: 'portcity' }), 'issuer_mismatch');
    expect(() => verifyJwtHs256(token, secret)).not.toThrow();
  });

  it('refuses to sign with an empty secret', () => {
    expect(() => signJwtHs256({ sub: 'u' }, '')).toThrow();
  });
});
