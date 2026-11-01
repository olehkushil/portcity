import { uuidv7 } from 'uuidv7';
import type { DbClient } from '../../../common/prisma/prisma.service';
import type { ImportableTenantFields, NormalizedImportItem } from '../domain/import-mapper';
import type {
  ContentImportRepository,
  ExistingImportTenant,
  ImportDefaults,
} from '../jobs/content-import.job';

/** Prisma adapter for `runContentImport`; `db` is the open transaction of the run. */
export class PrismaContentImportRepository implements ContentImportRepository {
  constructor(
    private readonly db: DbClient,
    private readonly now: () => Date,
  ) {}

  findBySlugs(slugs: readonly string[]): Promise<ExistingImportTenant[]> {
    return this.db.tenant.findMany({
      where: { slug: { in: [...slugs] } },
      select: {
        id: true,
        slug: true,
        name: true,
        category: true,
        floor: true,
        website: true,
        phone: true,
        description: true,
        logoKey: true,
      },
    });
  }

  async createTenant(item: NormalizedImportItem, defaults: ImportDefaults): Promise<void> {
    const now = this.now();
    await this.db.tenant.create({
      data: {
        id: uuidv7(),
        slug: item.slug,
        name: item.name,
        category: item.category,
        floor: item.floor,
        website: item.website,
        phone: item.phone,
        description: item.description,
        logoKey: item.logoKey,
        participates: defaults.participates,
        status: defaults.status,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  async updateTenant(id: string, patch: Partial<ImportableTenantFields>): Promise<void> {
    await this.db.tenant.update({ where: { id }, data: { ...patch, updatedAt: this.now() } });
  }
}
