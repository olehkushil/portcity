import type { Logger } from '@nestjs/common';
import type {
  ContentPort,
  TenantDisplaySummary,
  TenantSummary,
} from '../../../common/contracts/content';
import { tryPort } from './safe-port';

/** A tenant as far as the content module could tell (display summary when available). */
export type TenantCardSource = TenantSummary | TenantDisplaySummary;

/**
 * Tenant cards for vouchers and rewards, by id through CONTENT_PORT. Enrichment only: a failing
 * content module never breaks the caller. `getTenantSummaryById` is preferred because content
 * resolves the public logo URL itself (its own logo base URL); ids it cannot answer fall back to
 * the batch `getTenants`, whose summaries carry only `logoKey` (the view then builds
 * `S3_PUBLIC_BASE_URL + logoKey`).
 */
export async function loadTenantCards(
  content: ContentPort,
  logger: Logger,
  tenantIds: ReadonlyArray<string | null>,
): Promise<Map<string, TenantCardSource>> {
  const ids = [...new Set(tenantIds.filter((id): id is string => id !== null))];
  const cards = new Map<string, TenantCardSource>();
  if (ids.length === 0) {
    return cards;
  }
  const missing: string[] = [];
  if (typeof content.getTenantSummaryById === 'function') {
    const found = await Promise.all(
      ids.map((id) =>
        tryPort<TenantDisplaySummary | null | 'failed'>(
          logger,
          'content.getTenantSummaryById',
          () => content.getTenantSummaryById(id),
          'failed',
        ),
      ),
    );
    found.forEach((card, index) => {
      const id = ids[index] as string;
      if (card === 'failed') {
        missing.push(id);
      } else if (card) {
        cards.set(id, card);
      }
    });
  } else {
    missing.push(...ids);
  }
  if (missing.length > 0) {
    const tenants = await tryPort<TenantSummary[]>(
      logger,
      'content.getTenants',
      () => content.getTenants(missing),
      [],
    );
    for (const tenant of tenants) {
      cards.set(tenant.id, tenant);
    }
  }
  return cards;
}
