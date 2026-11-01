import { webhookPolicyViolation } from './webhook-policy';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const strict = { strict: true, maxAgeSeconds: 600, now: NOW };

describe('webhookPolicyViolation', () => {
  it.each([
    ['lenient adapter accepts anything', { kind: 'succeeded' as const }, false, null],
    ['strict success without amount', { kind: 'succeeded' as const }, true, 'amount_missing'],
    [
      'strict success without currency',
      { kind: 'succeeded' as const, amountKopecks: 6000 },
      true,
      'currency_missing',
    ],
    [
      'strict success with amount and currency',
      { kind: 'succeeded' as const, amountKopecks: 6000, currency: 'UAH' },
      true,
      null,
    ],
    ['strict failure needs no amount', { kind: 'failed' as const }, true, null],
    [
      'strict notification 601 s old',
      { kind: 'failed' as const, occurredAt: new Date(NOW.getTime() - 601_000) },
      true,
      'stale',
    ],
    [
      'strict notification 600 s old',
      { kind: 'failed' as const, occurredAt: new Date(NOW.getTime() - 600_000) },
      true,
      null,
    ],
    [
      'strict notification from the future',
      { kind: 'failed' as const, occurredAt: new Date(NOW.getTime() + 700_000) },
      true,
      'stale',
    ],
    ['strict notification without a timestamp', { kind: 'pending' as const }, true, null],
  ])('%s', (_name, event, isStrict, reason) => {
    const result = webhookPolicyViolation(event, { ...strict, strict: isStrict });
    expect(result?.reason ?? null).toBe(reason);
  });
});
