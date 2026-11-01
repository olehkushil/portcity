import { TENANT_STATUSES, type TenantStatus } from '../../../common/contracts/content';
import {
  TENANT_TRANSITIONS,
  assertTenantTransition,
  canTransitionTenant,
  isTenantExcludedFromProgram,
  isTenantPublic,
} from './tenant-state';

describe('tenant state machine', () => {
  const cases: ReadonlyArray<[TenantStatus, TenantStatus, boolean]> = [
    ['active', 'active', true],
    ['active', 'hidden', true],
    ['active', 'closed', true],
    ['hidden', 'active', true],
    ['hidden', 'hidden', true],
    ['hidden', 'closed', true],
    ['closed', 'active', true],
    ['closed', 'closed', true],
    ['closed', 'hidden', false],
  ];

  it.each(cases)('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canTransitionTenant(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertTenantTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTenantTransition(from, to)).toThrow(
        expect.objectContaining({ code: 'PC_TENANT_INVALID_TRANSITION', status: 409 }) as Error,
      );
    }
  });

  it('covers every status in the transition table', () => {
    expect(Object.keys(TENANT_TRANSITIONS).sort()).toEqual([...TENANT_STATUSES].sort());
    for (const targets of Object.values(TENANT_TRANSITIONS)) {
      for (const target of targets) {
        expect(TENANT_STATUSES).toContain(target);
      }
    }
  });

  it('exposes only active tenants publicly', () => {
    expect(isTenantPublic('active')).toBe(true);
    expect(isTenantPublic('hidden')).toBe(false);
    expect(isTenantPublic('closed')).toBe(false);
  });

  it.each([
    [{ excludedFromProgram: true, participates: true, status: 'active' }, true],
    [{ excludedFromProgram: false, participates: false, status: 'active' }, true],
    [{ excludedFromProgram: false, participates: true, status: 'closed' }, true],
    [{ excludedFromProgram: false, participates: true, status: 'hidden' }, false],
    [{ excludedFromProgram: false, participates: true, status: 'active' }, false],
  ] as const)('exclusion for %j is %s', (tenant, excluded) => {
    expect(isTenantExcludedFromProgram(tenant)).toBe(excluded);
  });
});
