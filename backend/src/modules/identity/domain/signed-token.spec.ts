import { signStatelessToken, verifyStatelessToken } from './signed-token';

describe('stateless signed tokens', () => {
  const secret = 'test-secret-0123456789';
  const now = new Date('2026-01-15T10:00:00Z');
  const payload = {
    purpose: 'admin-totp-challenge',
    subject: 'admin-1',
    expiresAt: Math.floor(now.getTime() / 1000) + 300,
    data: { ip: '127.0.0.1' },
  };

  it('round-trips a payload', () => {
    const token = signStatelessToken(payload, secret);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(verifyStatelessToken(token, secret, 'admin-totp-challenge', now)).toEqual(payload);
  });

  it.each([
    [
      'other secret',
      (token: string) => token,
      'other-secret-0123456789',
      'admin-totp-challenge',
      now,
    ],
    ['other purpose', (token: string) => token, secret, 'admin-totp-setup', now],
    [
      'expired',
      (token: string) => token,
      secret,
      'admin-totp-challenge',
      new Date('2026-01-15T10:05:00Z'),
    ],
    [
      'tampered payload',
      (token: string) =>
        `${Buffer.from('{"purpose":"admin-totp-challenge","subject":"admin-2","expiresAt":9999999999}').toString('base64url')}.${token.split('.')[1] ?? ''}`,
      secret,
      'admin-totp-challenge',
      now,
    ],
    [
      'missing signature',
      (token: string) => token.split('.')[0] ?? '',
      secret,
      'admin-totp-challenge',
      now,
    ],
    ['garbage', () => 'not-a-token', secret, 'admin-totp-challenge', now],
    ['empty', () => '', secret, 'admin-totp-challenge', now],
  ])('rejects %s', (_name, mutate, verifySecret, purpose, at) => {
    const token = mutate(signStatelessToken(payload, secret));
    expect(verifyStatelessToken(token, verifySecret, purpose, at)).toBeNull();
  });

  it('rejects payloads whose data is not a string map', () => {
    const encoded = Buffer.from(
      JSON.stringify({ purpose: 'p', subject: 's', expiresAt: 9999999999, data: { n: 1 } }),
    ).toString('base64url');
    const valid = signStatelessToken({ purpose: 'p', subject: 's', expiresAt: 9999999999 }, secret);
    const signature = valid.split('.')[1] ?? '';
    expect(verifyStatelessToken(`${encoded}.${signature}`, secret, 'p', now)).toBeNull();
  });

  it('requires a secret to sign', () => {
    expect(() => signStatelessToken(payload, '')).toThrow(/secret/);
  });
});
