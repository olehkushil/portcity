import { type RefreshDecision, decideRefresh, isActiveSession } from './refresh-rotation';

describe('decideRefresh', () => {
  const now = new Date('2026-01-15T10:00:00Z');
  const future = new Date('2026-03-01T00:00:00Z');
  const past = new Date('2026-01-01T00:00:00Z');
  const justNow = new Date('2026-01-15T09:59:55Z');

  it.each<[string, Parameters<typeof decideRefresh>[0], RefreshDecision]>([
    ['fresh token', { expiresAt: future, revokedAt: null, replacedById: null }, 'rotate'],
    ['rotated token', { expiresAt: future, revokedAt: past, replacedById: 'next' }, 'reused'],
    [
      'rotated token that also expired',
      { expiresAt: past, revokedAt: past, replacedById: 'next' },
      'reused',
    ],
    [
      'rotated 5 seconds ago (grace window)',
      { expiresAt: future, revokedAt: justNow, replacedById: 'next' },
      'revoked',
    ],
    ['revoked by logout', { expiresAt: future, revokedAt: past, replacedById: null }, 'revoked'],
    ['expired', { expiresAt: past, revokedAt: null, replacedById: null }, 'expired'],
    ['expires exactly now', { expiresAt: now, revokedAt: null, replacedById: null }, 'expired'],
  ])('%s -> %s', (_name, token, expected) => {
    expect(decideRefresh(token, now)).toBe(expected);
    expect(isActiveSession(token, now)).toBe(expected === 'rotate');
  });

  it('honours a custom grace window', () => {
    const token = { expiresAt: future, revokedAt: justNow, replacedById: 'next' };
    expect(decideRefresh(token, now, { reuseGraceSeconds: 0 })).toBe('reused');
    expect(decideRefresh(token, now, { reuseGraceSeconds: 60 })).toBe('revoked');
  });
});
