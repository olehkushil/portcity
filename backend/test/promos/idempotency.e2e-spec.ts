import request from 'supertest';
import { getValidatedEnv } from '../../src/common/config';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { FakeClock } from '../../src/common/time/clock';
import { PromosService } from '../../src/modules/promos/services/promos.service';
import { type TestApp, createTestApp } from '../utils/app-factory';

/**
 * Regression for the Idempotency-Key scope (review finding): the key used for one resource must
 * not replay its response for another resource of the same route template. Runs the real
 * IdempotencyInterceptor and IdempotencyService over an in-memory idempotency_keys table.
 */

interface KeyRow {
  scope: string;
  key: string;
  requestHash: string;
  status: number | null;
  response: unknown;
  createdAt: Date;
  expiresAt: Date;
}

type KeyWhere = Partial<Pick<KeyRow, 'scope' | 'key' | 'status' | 'createdAt'>> & {
  expiresAt?: { lte?: Date; lt?: Date };
};

function matches(row: KeyRow, where: KeyWhere): boolean {
  if (where.scope !== undefined && row.scope !== where.scope) return false;
  if (where.key !== undefined && row.key !== where.key) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.createdAt !== undefined && row.createdAt.getTime() !== where.createdAt.getTime()) {
    return false;
  }
  if (where.expiresAt?.lte && row.expiresAt.getTime() > where.expiresAt.lte.getTime()) {
    return false;
  }
  if (where.expiresAt?.lt && row.expiresAt.getTime() >= where.expiresAt.lt.getTime()) {
    return false;
  }
  return true;
}

class InMemoryIdempotencyKeys {
  readonly rows: KeyRow[] = [];
  /** Number of upcoming `complete` writes that fail (simulates a dropped connection). */
  failNextStores = 0;

  readonly idempotencyKey = {
    findUnique: async (args: { where: { scope_key: { scope: string; key: string } } }) => {
      const { scope, key } = args.where.scope_key;
      const row = this.rows.find((entry) => entry.scope === scope && entry.key === key);
      return row ? { ...row } : null;
    },
    create: async (args: { data: Omit<KeyRow, 'status' | 'response'> }) => {
      const row: KeyRow = { status: null, response: null, ...args.data };
      this.rows.push(row);
      return { ...row };
    },
    updateMany: async (args: { where: KeyWhere; data: Partial<KeyRow> }) => {
      if (
        'status' in args.data &&
        typeof args.data.status === 'number' &&
        this.failNextStores > 0
      ) {
        this.failNextStores -= 1;
        throw new Error('connection reset while storing the response');
      }
      let count = 0;
      for (const row of this.rows) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
    deleteMany: async (args: { where: KeyWhere }) => {
      const before = this.rows.length;
      for (let index = this.rows.length - 1; index >= 0; index -= 1) {
        const row = this.rows[index];
        if (row && matches(row, args.where)) {
          this.rows.splice(index, 1);
        }
      }
      return { count: before - this.rows.length };
    },
  };
}

const PROMO_A = '01900000-0000-7000-8000-0000000000a1';
const PROMO_B = '01900000-0000-7000-8000-0000000000b2';
const MEMBER = '01900000-0000-7000-8000-000000000001';

describe('Idempotency-Key across resources of one route (e2e)', () => {
  const clock = new FakeClock('2026-11-01T10:00:00.000Z');
  const keys = new InMemoryIdempotencyKeys();
  const claims: string[] = [];
  const promos = {
    claim: jest.fn(async (promoId: string) => {
      claims.push(promoId);
      return { promoId, voucher: { id: `voucher-${claims.length}` } };
    }),
  };
  let testApp: TestApp;
  let auth: string;

  beforeAll(async () => {
    const service = new IdempotencyService(
      keys as unknown as PrismaService,
      clock,
      getValidatedEnv(),
      { IDEMPOTENCY_LEASE_SECONDS: 120 },
    );
    testApp = await createTestApp({
      clock,
      configure: (builder) =>
        builder
          .overrideProvider(IdempotencyService)
          .useValue(service)
          .overrideProvider(PromosService)
          .useValue(promos),
    });
    auth = `Bearer ${testApp.memberToken(MEMBER)}`;
  });

  afterAll(async () => {
    await testApp.close();
  });

  const claim = (promoId: string, key: string) =>
    request(testApp.server)
      .post(`/api/v1/promos/${promoId}/claim`)
      .set('Authorization', auth)
      .set('Idempotency-Key', key);

  it('replays the same resource and refuses the key on another resource with 409', async () => {
    const first = await claim(PROMO_A, 'key-resource-0001').expect(201);
    expect(first.body).toMatchObject({ promoId: PROMO_A });

    const replay = await claim(PROMO_A, 'key-resource-0001').expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);

    const other = await claim(PROMO_B, 'key-resource-0001').expect(409);
    expect(other.body).toMatchObject({ code: 'PC_COMMON_IDEMPOTENCY_MISMATCH' });
    expect(claims).toEqual([PROMO_A]);

    // A fresh key for B executes B.
    await claim(PROMO_B, 'key-resource-0002').expect(201);
    expect(claims).toEqual([PROMO_A, PROMO_B]);
  });

  it('does not execute twice when storing the response failed after the handler committed', async () => {
    claims.length = 0;
    keys.failNextStores = 1;
    const first = await claim(PROMO_A, 'key-store-fails-01').expect(201);
    expect(first.body).toMatchObject({ promoId: PROMO_A });
    const row = keys.rows.find((entry) => entry.key === 'key-store-fails-01');
    expect(row).toMatchObject({ status: null });

    // The client retries at once: the key is still owned, nothing runs a second time.
    const retry = await claim(PROMO_A, 'key-store-fails-01').expect(409);
    expect(retry.body).toMatchObject({ code: 'PC_COMMON_IDEMPOTENCY_IN_PROGRESS' });
    expect(claims).toEqual([PROMO_A]);
  });

  it('lets a retry take over a key left in progress by a crashed request after the lease', async () => {
    claims.length = 0;
    const crashedAt = clock.now();
    await claim(PROMO_B, 'key-crashed-000001').expect(201);
    // Simulate the crash: the request claimed the key but never stored its response.
    const row = keys.rows.find((entry) => entry.key === 'key-crashed-000001');
    if (!row) {
      throw new Error('row missing');
    }
    Object.assign(row, { status: null, response: null, createdAt: crashedAt });
    claims.length = 0;

    await claim(PROMO_B, 'key-crashed-000001').expect(409);
    expect(claims).toEqual([]);

    clock.advance(121_000);
    await claim(PROMO_B, 'key-crashed-000001').expect(201);
    expect(claims).toEqual([PROMO_B]);
  });
});
