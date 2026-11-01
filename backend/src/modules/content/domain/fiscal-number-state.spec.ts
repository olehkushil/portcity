import { FISCAL_NUMBER_STATUSES, type FiscalNumberStatus } from '../../../common/contracts/content';
import {
  FISCAL_NUMBER_TRANSITIONS,
  assertFiscalNumberDecision,
  canTransitionFiscalNumber,
  decideFiscalNumberTransition,
  isFiscalNumberWhitelisted,
} from './fiscal-number-state';

describe('fiscal number state machine', () => {
  const transitions: ReadonlyArray<[FiscalNumberStatus, FiscalNumberStatus, boolean]> = [
    ['pending', 'pending', true],
    ['pending', 'active', true],
    ['pending', 'blocked', true],
    ['active', 'active', true],
    ['active', 'blocked', true],
    ['active', 'pending', false],
    ['blocked', 'blocked', true],
    ['blocked', 'active', true],
    ['blocked', 'pending', true],
  ];

  it.each(transitions)('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionFiscalNumber(from, to)).toBe(allowed);
  });

  it('covers every status in the transition table', () => {
    expect(Object.keys(FISCAL_NUMBER_TRANSITIONS).sort()).toEqual(
      [...FISCAL_NUMBER_STATUSES].sort(),
    );
  });

  const tenant = '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11';

  const decisions = [
    {
      name: 'confirm a pending number with a tenant',
      current: { status: 'pending', tenantId: null },
      target: { status: 'active', tenantId: tenant },
      expected: { ok: true, next: { status: 'active', tenantId: tenant }, changed: true },
    },
    {
      name: 'confirm a pending number that is already mapped',
      current: { status: 'pending', tenantId: tenant },
      target: { status: 'active' },
      expected: { ok: true, next: { status: 'active', tenantId: tenant }, changed: true },
    },
    {
      name: 'confirm without a tenant is rejected',
      current: { status: 'pending', tenantId: null },
      target: { status: 'active' },
      expected: { ok: false, reason: 'tenant_required' },
    },
    {
      name: 'unmapping an active number is rejected',
      current: { status: 'active', tenantId: tenant },
      target: { tenantId: null },
      expected: { ok: false, reason: 'tenant_required' },
    },
    {
      name: 'active back to pending is an invalid transition',
      current: { status: 'active', tenantId: tenant },
      target: { status: 'pending' },
      expected: { ok: false, reason: 'invalid_transition' },
    },
    {
      name: 'blocking keeps the mapping',
      current: { status: 'active', tenantId: tenant },
      target: { status: 'blocked' },
      expected: { ok: true, next: { status: 'blocked', tenantId: tenant }, changed: true },
    },
    {
      name: 'no-op update is allowed and unchanged',
      current: { status: 'pending', tenantId: null },
      target: {},
      expected: { ok: true, next: { status: 'pending', tenantId: null }, changed: false },
    },
    {
      name: 'remapping a pending number changes only the tenant',
      current: { status: 'pending', tenantId: null },
      target: { tenantId: tenant },
      expected: { ok: true, next: { status: 'pending', tenantId: tenant }, changed: true },
    },
  ] as const;

  it.each(decisions)('$name', ({ current, target, expected }) => {
    expect(decideFiscalNumberTransition(current, target)).toMatchObject(expected);
  });

  it('assertFiscalNumberDecision maps reasons to error codes', () => {
    const current = { status: 'active', tenantId: tenant } as const;
    expect(() =>
      assertFiscalNumberDecision(
        decideFiscalNumberTransition(current, { status: 'pending' }),
        current,
      ),
    ).toThrow(expect.objectContaining({ code: 'PC_FISCAL_NUMBER_INVALID_TRANSITION' }) as Error);
    expect(() =>
      assertFiscalNumberDecision(
        decideFiscalNumberTransition(current, { tenantId: null }),
        current,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'PC_FISCAL_NUMBER_TENANT_REQUIRED', status: 422 }) as Error,
    );
    expect(() =>
      assertFiscalNumberDecision(
        decideFiscalNumberTransition(current, { status: 'blocked' }),
        current,
      ),
    ).not.toThrow();
  });

  it('whitelists only active numbers', () => {
    expect(isFiscalNumberWhitelisted('active')).toBe(true);
    expect(isFiscalNumberWhitelisted('pending')).toBe(false);
    expect(isFiscalNumberWhitelisted('blocked')).toBe(false);
  });
});
