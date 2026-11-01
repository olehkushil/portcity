import type { Logger } from '@nestjs/common';
import type { ContentPort, TenantSummary } from '../../../common/contracts/content';
import type { ReceiptTenantDto } from '../dto/receipt-responses.dto';
import { toTenantDto } from './receipt-view';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Batch tenant lookup for list and detail views. Tenant names are decoration: when the content
 * port fails the receipts are still returned, without tenants.
 */
export async function loadTenantDtos(
  content: ContentPort,
  tenantIds: ReadonlyArray<string | null>,
  logger?: Logger,
): Promise<Map<string, ReceiptTenantDto>> {
  const ids = [...new Set(tenantIds.filter((id): id is string => id !== null))];
  const result = new Map<string, ReceiptTenantDto>();
  if (ids.length === 0) {
    return result;
  }
  try {
    for (const tenant of await content.getTenants(ids)) {
      const dto = toTenantDto(tenant);
      if (dto) {
        result.set(tenant.id, dto);
      }
    }
  } catch (error) {
    logger?.warn(`Tenant lookup failed: ${describe(error)}`);
  }
  return result;
}

export async function loadTenant(
  content: ContentPort,
  tenantId: string | null,
  logger?: Logger,
): Promise<TenantSummary | null> {
  if (tenantId === null) {
    return null;
  }
  try {
    return await content.getTenant(tenantId);
  } catch (error) {
    logger?.warn(`Tenant lookup failed for ${tenantId}: ${describe(error)}`);
    return null;
  }
}
