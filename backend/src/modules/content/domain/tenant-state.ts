import { type TenantStatus } from '../../../common/contracts/content';
import { DomainError } from '../../../common/errors/domain-error';
import { ContentErrors } from './errors';

/**
 * Tenant status machine (brief section 6 style, pure):
 *
 *   active <-> hidden        (hide a tenant from the directory and bring it back)
 *   active | hidden -> closed (the tenant left the mall)
 *   closed -> active          (reopening; a closed tenant cannot go straight to hidden)
 *
 * Staying in the same status is always allowed (no-op update).
 */
export const TENANT_TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> =
  Object.freeze({
    active: ['hidden', 'closed'],
    hidden: ['active', 'closed'],
    closed: ['active'],
  });

export function canTransitionTenant(from: TenantStatus, to: TenantStatus): boolean {
  return from === to || TENANT_TRANSITIONS[from].includes(to);
}

export function assertTenantTransition(from: TenantStatus, to: TenantStatus): void {
  if (!canTransitionTenant(from, to)) {
    throw new DomainError(
      ContentErrors.PC_TENANT_INVALID_TRANSITION,
      `Tenant status cannot change from "${from}" to "${to}"`,
      { details: { from, to, allowed: TENANT_TRANSITIONS[from] } },
    );
  }
}

/** Only active tenants appear in public endpoints (GET /tenants, GET /tenants/:slug). */
export function isTenantPublic(status: TenantStatus): boolean {
  return status === 'active';
}

/**
 * True when receipts from the tenant's cash registers must not earn points:
 * the tenant is excluded by policy (anchor tenants such as the hypermarket), does not
 * participate in the program, or has closed. Hidden tenants still earn (not yet listed).
 */
export function isTenantExcludedFromProgram(tenant: {
  excludedFromProgram: boolean;
  participates: boolean;
  status: TenantStatus;
}): boolean {
  return tenant.excludedFromProgram || !tenant.participates || tenant.status === 'closed';
}
