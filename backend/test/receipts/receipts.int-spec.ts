import { uuidv7 } from 'uuidv7';
import { ReceiptsRepository } from '../../src/modules/receipts/services/receipts.repository';
import { createTestApp, type TestApp } from '../utils/app-factory';
import { describeWithDb, resetDatabase } from '../utils/int';

const FN = '4000100011';

/**
 * Receipts repository against PostgreSQL (self-skips without DATABASE_URL; CI runs it): the
 * per-member advisory lock, the canonical (fn, fiscal_id) key with a NULL fn, and the queries
 * behind the anti-fraud rules.
 */
describeWithDb('receipts repository (integration)', () => {
  let testApp: TestApp;
  let repo: ReceiptsRepository;
  let userId: string;
  let otherUserId: string;

  async function createUser(code: string): Promise<string> {
    const id = uuidv7();
    await testApp.prisma.user.create({
      data: { id, phone: `+38050${code}`, memberCode: code.padStart(9, '7') },
    });
    return id;
  }

  async function receipt(
    overrides: Partial<{
      userId: string;
      fn: string | null;
      fiscalId: string;
      totalKopecks: number;
      issuedAt: Date;
      submittedAt: Date;
      source: 'qr' | 'manual';
    }> = {},
  ): Promise<string> {
    const id = uuidv7();
    const now = new Date();
    await repo.create(testApp.prisma, {
      id,
      userId: overrides.userId ?? userId,
      deviceId: null,
      fn: overrides.fn === undefined ? FN : overrides.fn,
      fiscalId: overrides.fiscalId ?? id.replace(/-/g, '').slice(-12).toUpperCase(),
      fnRaw: null,
      fiscalIdRaw: null,
      issuedAt: overrides.issuedAt ?? now,
      totalKopecks: overrides.totalKopecks ?? 12_345,
      rawQr: null,
      source: overrides.source ?? 'qr',
      photoKey: null,
      tenantId: null,
      status: 'parsed',
      riskFlags: [],
      riskScore: 0,
      submittedAt: overrides.submittedAt ?? now,
      createdAt: now,
    });
    return id;
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    repo = testApp.app.get(ReceiptsRepository);
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await resetDatabase(testApp.prisma);
    userId = await createUser('1234567');
    otherUserId = await createUser('7654321');
  });

  it('takes the per-member advisory lock inside a transaction', async () => {
    await expect(
      testApp.prisma.withTx(async (tx) => {
        await repo.lockMember(tx, userId);
        // Re-entrant within the same transaction.
        await repo.lockMember(tx, userId);
        return 'locked';
      }),
    ).resolves.toBe('locked');
  });

  it('enforces the canonical key but lets manual receipts without fn coexist', async () => {
    await receipt({ fiscalId: '1180000001' });
    await expect(receipt({ fiscalId: '1180000001' })).rejects.toMatchObject({ code: 'P2002' });
    await receipt({ fn: null, fiscalId: '777', source: 'manual' });
    await receipt({ fn: null, fiscalId: '777', source: 'manual' });
    await expect(repo.findByFnAndFiscalId(testApp.prisma, FN, '1180000001')).resolves.toMatchObject(
      {
        fiscalId: '1180000001',
      },
    );
  });

  it('answers the anti-fraud queries', async () => {
    const since = new Date(Date.now() - 3_600_000);
    await receipt({ userId: otherUserId, totalKopecks: 43_210 });
    const mine = await receipt({ totalKopecks: 43_210 });
    await expect(
      repo.existsSameTotalFromOtherUser(testApp.prisma, {
        receiptId: mine,
        userId,
        fn: FN,
        totalKopecks: 43_210,
        since,
      }),
    ).resolves.toBe(true);
    await expect(repo.listTotalsForUserSince(testApp.prisma, userId, since)).resolves.toEqual([
      43_210,
    ]);
    // The receipt under evaluation is excluded from its own neighbours.
    const neighbours = await repo.listFiscalIdNeighbours(testApp.prisma, {
      receiptId: mine,
      fn: FN,
      issuedAt: new Date(Date.now() + 60_000),
      limit: 5,
    });
    expect(neighbours).toHaveLength(1);
    const allNeighbours = await repo.listFiscalIdNeighbours(testApp.prisma, {
      receiptId: uuidv7(),
      fn: FN,
      issuedAt: new Date(Date.now() + 60_000),
      limit: 5,
    });
    expect(allNeighbours).toHaveLength(2);
    await expect(
      repo.sumQrPointsForUserBetween(testApp.prisma, userId, since, new Date(Date.now() + 60_000)),
    ).resolves.toBe(0);
    await expect(repo.listPendingVerification(testApp.prisma, 10)).resolves.toEqual([]);
  });
});
