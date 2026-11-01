import type { PrismaService } from '../../../src/common/prisma/prisma.service';

/** A fake store that can be rolled back when a fake transaction throws. */
export interface Snapshotable {
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

/** Marker passed as `tx` to repository and port methods inside fake transactions. */
export const FAKE_TX = Object.freeze({ fakeTx: true });

export interface FakePrisma {
  /** Number of transactions opened so far. */
  transactions: number;
  /** Number of transactions rolled back. */
  rollbacks: number;
  service: PrismaService;
}

/**
 * PrismaService stand-in for unit tests: `withTx` runs the callback with a marker transaction
 * and restores every registered store when the callback throws, like a database rollback.
 */
export function createFakePrisma(stores: readonly Snapshotable[]): FakePrisma {
  const fake: FakePrisma = {
    transactions: 0,
    rollbacks: 0,
    service: undefined as unknown as PrismaService,
  };
  const withTx = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    fake.transactions += 1;
    const snapshots = stores.map((store) => store.snapshot());
    try {
      return await fn(FAKE_TX);
    } catch (error) {
      fake.rollbacks += 1;
      stores.forEach((store, index) => store.restore(snapshots[index]));
      throw error;
    }
  };
  const runInTx = async <T>(tx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    tx ? fn(tx) : withTx(fn);
  // Typed escape hatch: only withTx/runInTx are used by the receipts services.
  fake.service = { withTx, runInTx } as unknown as PrismaService;
  return fake;
}
