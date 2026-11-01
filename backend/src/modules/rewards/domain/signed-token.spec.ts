import { parseExpiringToken, signExpiringToken, toUnixSeconds } from './signed-token';

const SECRET = 'unit-test-secret';
const NOW = new Date('2026-11-01T10:00:00.000Z');
const EXP = toUnixSeconds(NOW) + 120;

function sign(overrides: Partial<Parameters<typeof signExpiringToken>[0]> = {}): string {
  return signExpiringToken({
    kind: 'k',
    subject: 'subject-1',
    exp: EXP,
    secret: SECRET,
    ...overrides,
  });
}

function raw(token: string): string {
  return Buffer.from(token, 'base64url').toString('utf8');
}

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('signExpiringToken', () => {
  it('produces base64url(subject.exp.hmac)', () => {
    const token = sign();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const parts = raw(token).split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('subject-1');
    expect(parts[1]).toBe(String(EXP));
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(sign()).toBe(sign());
  });

  it.each([
    ['subject with a space', { subject: 'bad subject' }],
    ['empty subject', { subject: '' }],
    ['subject over 128 chars', { subject: 'a'.repeat(129) }],
    ['fractional exp', { exp: 1.5 }],
    ['zero exp', { exp: 0 }],
    ['negative exp', { exp: -10 }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => sign(overrides)).toThrow();
  });
});

describe('parseExpiringToken', () => {
  const options = { kind: 'k', secret: SECRET, now: NOW };

  it('accepts a valid token and returns subject and expiry', () => {
    expect(parseExpiringToken(sign(), options)).toEqual({
      ok: true,
      subject: 'subject-1',
      exp: EXP,
      expiresAt: new Date(EXP * 1000),
    });
  });

  const failures: Array<
    [string, () => string, Partial<typeof options> & { extra?: string[] }, string]
  > = [
    ['empty string', () => '', {}, 'malformed'],
    ['non base64url characters', () => 'abc+/=', {}, 'malformed'],
    ['too long', () => 'a'.repeat(513), {}, 'malformed'],
    ['two parts', () => encode('subject-1.123'), {}, 'malformed'],
    ['four parts', () => encode('a.b.c.d'), {}, 'malformed'],
    ['non numeric exp', () => encode('subject-1.abc.mac'), {}, 'malformed'],
    ['empty mac', () => encode(`subject-1.${EXP}.`), {}, 'malformed'],
    ['bad subject characters', () => encode(`sub ject.${EXP}.mac`), {}, 'malformed'],
    ['wrong secret', () => sign({ secret: 'other' }), {}, 'bad_signature'],
    ['wrong kind', () => sign({ kind: 'other-kind' }), {}, 'bad_signature'],
    [
      'tampered subject',
      () => encode(raw(sign()).replace('subject-1', 'subject-2')),
      {},
      'bad_signature',
    ],
    [
      'tampered exp',
      () => encode(raw(sign()).replace(String(EXP), String(EXP + 1000))),
      {},
      'bad_signature',
    ],
    ['extra material differs', () => sign({ extra: ['a'] }), { extra: ['b'] }, 'bad_signature'],
    ['missing extra material', () => sign({ extra: ['a'] }), {}, 'bad_signature'],
    ['expired one second ago', () => sign({ exp: toUnixSeconds(NOW) - 1 }), {}, 'expired'],
    ['expiring exactly now', () => sign({ exp: toUnixSeconds(NOW) }), {}, 'expired'],
  ];

  it.each(failures)('rejects %s', (_name, token, overrides, reason) => {
    expect(parseExpiringToken(token(), { ...options, ...overrides })).toEqual({
      ok: false,
      reason,
    });
  });

  it('accepts matching extra material', () => {
    const token = sign({ extra: ['fp-1'] });
    expect(parseExpiringToken(token, { ...options, extra: ['fp-1'] }).ok).toBe(true);
  });

  it('never throws on arbitrary input', () => {
    for (const input of ['....', 'Zm9v', '_-_-', encode('\u0000.\u0000.\u0000')]) {
      expect(() => parseExpiringToken(input, options)).not.toThrow();
    }
  });
});

describe('toUnixSeconds', () => {
  it.each([
    ['2026-11-01T10:00:00.000Z', 1793527200],
    ['2026-11-01T10:00:00.999Z', 1793527200],
    ['1970-01-01T00:00:01.000Z', 1],
  ])('%s -> %i', (iso, seconds) => {
    expect(toUnixSeconds(new Date(iso))).toBe(seconds);
  });
});
