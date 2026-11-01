import type { ImportableTenantFields, NormalizedImportItem } from '../domain/import-mapper';
import {
  type ContentImportRepository,
  type ExistingImportTenant,
  type ImportDefaults,
  MAX_REPORTED_MESSAGES,
  runContentImport,
} from './content-import.job';

class InMemoryImportRepository implements ContentImportRepository {
  readonly tenants: ExistingImportTenant[];
  readonly created: Array<{ item: NormalizedImportItem; defaults: ImportDefaults }> = [];
  readonly updated: Array<{ id: string; patch: Partial<ImportableTenantFields> }> = [];

  constructor(tenants: ExistingImportTenant[] = []) {
    this.tenants = tenants;
  }

  async findBySlugs(slugs: readonly string[]): Promise<ExistingImportTenant[]> {
    return this.tenants.filter((tenant) => slugs.includes(tenant.slug));
  }

  async createTenant(item: NormalizedImportItem, defaults: ImportDefaults): Promise<void> {
    this.created.push({ item, defaults });
  }

  async updateTenant(id: string, patch: Partial<ImportableTenantFields>): Promise<void> {
    this.updated.push({ id, patch });
  }
}

const intertop: ExistingImportTenant = {
  id: 'tenant-1',
  slug: 'intertop',
  name: 'INTERTOP',
  category: 'fashion',
  floor: 1,
  website: 'https://intertop.ua/',
  phone: null,
  description: null,
  logoKey: null,
};

describe('runContentImport', () => {
  it('creates new tenants with the default program flags and updates existing ones', async () => {
    const repo = new InMemoryImportRepository([intertop]);
    const stats = await runContentImport(
      {
        source: 'wordpress',
        items: [
          { slug: 'intertop', name: 'INTERTOP', floor: 2 },
          { name: 'Aroma Kava', category: 'Кава', floor: 1 },
          { slug: 'intertop', name: 'INTERTOP duplicate' },
          { name: '' },
        ],
      },
      repo,
    );

    expect(stats).toMatchObject({
      source: 'wordpress',
      dryRun: false,
      received: 4,
      valid: 3,
      invalid: 1,
      duplicates: 1,
      created: 1,
      updated: 1,
      unchanged: 0,
      createdSlugs: ['aroma-kava'],
      updatedSlugs: ['intertop'],
      issues: ['item 3: name is required'],
    });
    expect(stats.warnings).toEqual(
      expect.arrayContaining([
        'item 1 (Aroma Kava): slug normalised to "aroma-kava"',
        'duplicate slug "intertop" skipped',
      ]),
    );
    expect(repo.created).toEqual([
      {
        item: expect.objectContaining({ slug: 'aroma-kava', category: 'coffee', floor: 1 }),
        defaults: { status: 'active', participates: false },
      },
    ]);
    expect(repo.updated).toEqual([{ id: 'tenant-1', patch: { floor: 2 } }]);
  });

  it('counts unchanged tenants and writes nothing in dry run', async () => {
    const repo = new InMemoryImportRepository([intertop]);
    const stats = await runContentImport(
      {
        source: 'manual',
        dryRun: true,
        items: [
          { slug: 'intertop', name: 'INTERTOP' },
          { slug: 'new-shop', name: 'New Shop' },
        ],
      },
      repo,
    );
    expect(stats).toMatchObject({
      dryRun: true,
      created: 1,
      updated: 0,
      unchanged: 1,
      createdSlugs: ['new-shop'],
    });
    expect(repo.created).toHaveLength(0);
    expect(repo.updated).toHaveLength(0);
  });

  it('applies custom defaults for created tenants', async () => {
    const repo = new InMemoryImportRepository();
    await runContentImport(
      {
        source: 'manual',
        items: [{ slug: 'shop', name: 'Shop' }],
        defaults: { status: 'hidden', participates: true },
      },
      repo,
    );
    expect(repo.created[0]?.defaults).toEqual({ status: 'hidden', participates: true });
  });

  it('keeps the defaults for fields that are present but undefined (DTO instances)', async () => {
    const repo = new InMemoryImportRepository();
    await runContentImport(
      {
        source: 'manual',
        items: [{ slug: 'shop', name: 'Shop' }],
        defaults: { status: undefined, participates: true },
      },
      repo,
    );
    expect(repo.created[0]?.defaults).toEqual({ status: 'active', participates: true });
  });

  it('does not query the repository when every item is invalid', async () => {
    const repo = new InMemoryImportRepository();
    const findSpy = jest.spyOn(repo, 'findBySlugs');
    const stats = await runContentImport({ source: 'manual', items: [{ name: ' ' }] }, repo);
    expect(findSpy).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ received: 1, valid: 0, invalid: 1, created: 0 });
  });

  it('caps the reported message lists', async () => {
    const repo = new InMemoryImportRepository();
    const items = Array.from({ length: MAX_REPORTED_MESSAGES + 5 }, (_, i) => ({
      slug: `shop-${i}`,
      name: `Shop ${i}`,
    }));
    const stats = await runContentImport({ source: 'manual', items }, repo);
    expect(stats.created).toBe(MAX_REPORTED_MESSAGES + 5);
    expect(stats.createdSlugs).toHaveLength(MAX_REPORTED_MESSAGES + 1);
    expect(stats.createdSlugs[MAX_REPORTED_MESSAGES]).toBe('... and 5 more');
  });
});
