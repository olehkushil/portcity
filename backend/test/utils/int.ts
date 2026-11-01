import type { PrismaService } from '../../src/common/prisma/prisma.service';

/** True when integration tests may touch PostgreSQL. */
export const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * `describeWithDb('ledger', () => { ... })` self-skips without DATABASE_URL (brief section 1).
 */
export const describeWithDb: jest.Describe = hasDatabase ? describe : describe.skip;

/** Truncates every public table except Prisma's migration log. Only for test databases. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
