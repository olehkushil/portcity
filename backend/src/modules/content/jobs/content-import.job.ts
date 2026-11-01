import type { TenantStatus } from '../../../common/contracts/content';
import {
  type ContentImportItem,
  type ImportableTenantFields,
  type NormalizedImportItem,
  dedupeImportItems,
  diffImportedTenant,
  normalizeImportItem,
} from '../domain/import-mapper';

/**
 * Handler logic of the content import (brief section 9 style: a plain function with a unit
 * test; the service only wires Prisma into `ContentImportRepository`). The admin endpoint runs
 * it synchronously by default or queues it on `content-import` (content-import-queue.job.ts).
 */

export const CONTENT_IMPORT_SOURCES = ['wordpress', 'manual'] as const;
export type ContentImportSource = (typeof CONTENT_IMPORT_SOURCES)[number];

export interface ImportDefaults {
  /** Status given to tenants created by the import. */
  status: TenantStatus;
  /** Program participation is a contract fact, so imported tenants start as non-participants. */
  participates: boolean;
}

export const DEFAULT_IMPORT_DEFAULTS: Readonly<ImportDefaults> = Object.freeze({
  status: 'active',
  participates: false,
});

export interface ExistingImportTenant extends ImportableTenantFields {
  id: string;
  slug: string;
}

export interface ContentImportRepository {
  findBySlugs(slugs: readonly string[]): Promise<ExistingImportTenant[]>;
  createTenant(item: NormalizedImportItem, defaults: ImportDefaults): Promise<void>;
  updateTenant(id: string, patch: Partial<ImportableTenantFields>): Promise<void>;
}

export interface ContentImportInput {
  source: ContentImportSource;
  items: readonly ContentImportItem[];
  dryRun?: boolean;
  defaults?: Partial<ImportDefaults>;
}

export interface ContentImportStats {
  source: ContentImportSource;
  dryRun: boolean;
  received: number;
  valid: number;
  invalid: number;
  duplicates: number;
  created: number;
  updated: number;
  unchanged: number;
  createdSlugs: string[];
  updatedSlugs: string[];
  issues: string[];
  warnings: string[];
}

/** Keeps the stats JSON small for the content_import_runs row. */
export const MAX_REPORTED_MESSAGES = 100;

function capped(messages: string[]): string[] {
  if (messages.length <= MAX_REPORTED_MESSAGES) {
    return messages;
  }
  const hidden = messages.length - MAX_REPORTED_MESSAGES;
  return [...messages.slice(0, MAX_REPORTED_MESSAGES), `... and ${hidden} more`];
}

export async function runContentImport(
  input: ContentImportInput,
  repository: ContentImportRepository,
): Promise<ContentImportStats> {
  const dryRun = input.dryRun ?? false;
  // Field by field: DTO instances carry declared-but-unset fields as own `undefined` properties
  // (ES2022 class fields), which a spread would copy over the defaults.
  const defaults: ImportDefaults = {
    status: input.defaults?.status ?? DEFAULT_IMPORT_DEFAULTS.status,
    participates: input.defaults?.participates ?? DEFAULT_IMPORT_DEFAULTS.participates,
  };
  const issues: string[] = [];
  const warnings: string[] = [];
  const normalized: NormalizedImportItem[] = [];

  input.items.forEach((raw, index) => {
    const result = normalizeImportItem(raw, index);
    if (result.ok) {
      normalized.push(result.item);
      warnings.push(...result.warnings);
    } else {
      issues.push(result.issue);
    }
  });

  const { items, duplicates } = dedupeImportItems(normalized);
  for (const slug of duplicates) {
    warnings.push(`duplicate slug "${slug}" skipped`);
  }

  const existing = items.length > 0 ? await repository.findBySlugs(items.map((i) => i.slug)) : [];
  const bySlug = new Map(existing.map((tenant) => [tenant.slug, tenant]));

  const createdSlugs: string[] = [];
  const updatedSlugs: string[] = [];
  let unchanged = 0;

  for (const item of items) {
    const current = bySlug.get(item.slug);
    if (!current) {
      if (!dryRun) {
        await repository.createTenant(item, defaults);
      }
      createdSlugs.push(item.slug);
      continue;
    }
    const patch = diffImportedTenant(current, item);
    if (Object.keys(patch).length === 0) {
      unchanged += 1;
      continue;
    }
    if (!dryRun) {
      await repository.updateTenant(current.id, patch);
    }
    updatedSlugs.push(item.slug);
  }

  return {
    source: input.source,
    dryRun,
    received: input.items.length,
    valid: normalized.length,
    invalid: issues.length,
    duplicates: duplicates.length,
    created: createdSlugs.length,
    updated: updatedSlugs.length,
    unchanged,
    createdSlugs: capped(createdSlugs),
    updatedSlugs: capped(updatedSlugs),
    issues: capped(issues),
    warnings: capped(warnings),
  };
}
