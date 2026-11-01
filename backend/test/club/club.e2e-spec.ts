import request from 'supertest';
import { buildOpenApiDocument } from '../../src/common/openapi/openapi';
import { CLUB_LEDGER_PORT, type ClubLedgerPort } from '../../src/common/contracts/club';
import { IDENTITY_PORT } from '../../src/common/contracts/identity';
import { WorkerSchedules } from '../../src/common/queue/worker-schedules.service';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { QUEUES } from '../../src/common/queue/queue.constants';
import { ClubRepository } from '../../src/modules/club/services/club.repository';
import { LedgerService } from '../../src/modules/club/services/ledger.service';
import { FakeIdentity } from '../../src/modules/club/testing/club-test-kit';
import { InMemoryClubRepository } from '../../src/modules/club/testing/in-memory-club.repository';
import { createTestApp, type TestApp } from '../utils/app-factory';

const USER = '0192f3a0-6c3e-7d2a-9c1b-000000000001';

/**
 * Club inside the full AppModule: the real LedgerService behind CLUB_LEDGER_PORT, routes,
 * guards, outbox routes and schedules. Persistence is the in-memory repository, so no database
 * is needed; the flows here only read, ledger writes with outbox rows are covered by
 * ledger.int-spec.ts against PostgreSQL.
 */
describe('club module (e2e)', () => {
  let testApp: TestApp;
  const repo = new InMemoryClubRepository();
  const identity = new FakeIdentity();

  beforeAll(async () => {
    testApp = await createTestApp({
      configure: (builder) =>
        builder
          .overrideProvider(ClubRepository)
          .useValue(repo)
          .overrideProvider(IDENTITY_PORT)
          .useValue(identity),
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('provides the real ledger under CLUB_LEDGER_PORT', () => {
    const port = testApp.moduleRef.get<ClubLedgerPort>(CLUB_LEDGER_PORT, { strict: false });
    expect(port).toBeInstanceOf(LedgerService);
  });

  it('registers its outbox routes and schedules', () => {
    const router = testApp.moduleRef.get(OutboxRouter, { strict: false });
    expect(router.resolve('user.registered')).toContain(QUEUES.clubEvents);
    expect(router.resolve('user.profile_completed')).toContain(QUEUES.clubEvents);
    expect(router.resolve('user.profile_field_completed')).toContain(QUEUES.clubEvents);
    expect(router.resolve('receipt.credited')).toContain(QUEUES.clubEvents);

    const schedules = testApp.moduleRef.get(WorkerSchedules, { strict: false });
    const ids = schedules.list().map((schedule) => schedule.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'points-release-holds-hourly',
        'points-expire-daily',
        'points-balance-drift-nightly',
      ]),
    );
  });

  it('serves the public rules without a token', async () => {
    const response = await request(testApp.server).get('/api/v1/club/rules');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ baseRatePercent: 3, pointsTtlMonths: 12 });
  });

  it('guards the member and admin routes', async () => {
    expect((await request(testApp.server).get('/api/v1/club/account')).status).toBe(401);
    expect((await request(testApp.server).get('/api/v1/club/transactions')).status).toBe(401);
    expect((await request(testApp.server).get('/api/v1/club/transactions/summary')).status).toBe(
      401,
    );
    expect((await request(testApp.server).get('/api/v1/admin/club/rule-sets')).status).toBe(401);
    const asMember = await request(testApp.server)
      .get('/api/v1/admin/club/rule-sets')
      .set('Authorization', `Bearer ${testApp.memberToken(USER)}`);
    expect(asMember.status).toBe(403);
  });

  it('returns an empty card and history for a member without an account', async () => {
    identity.add(USER, '734211800');
    const token = `Bearer ${testApp.memberToken(USER)}`;

    const account = await request(testApp.server)
      .get('/api/v1/club/account')
      .set('Authorization', token);
    expect(account.status).toBe(200);
    expect(account.body).toMatchObject({ accountId: null, balance: 0, memberCode: '734211800' });
    // RECEIPTS_PORT is looked up in the full app; whatever it answers, the card has the block.
    expect(account.body.pendingModeration).toEqual({
      count: expect.any(Number) as unknown,
      expectedPoints: expect.any(Number) as unknown,
    });

    const history = await request(testApp.server)
      .get('/api/v1/club/transactions')
      .set('Authorization', token);
    expect(history.body).toEqual({ items: [], nextCursor: null });

    const summary = await request(testApp.server)
      .get('/api/v1/club/transactions/summary?month=2026-11')
      .set('Authorization', token);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ month: '2026-11', earned: 0, spent: 0, expired: 0 });
  });

  it('documents GET /club/rules without a security requirement', async () => {
    const document = buildOpenApiDocument(testApp.app);
    const rules = document.paths['/api/v1/club/rules']?.get;
    expect(rules).toBeDefined();
    expect(rules?.security ?? []).toEqual([]);
    expect(document.paths['/api/v1/club/account']?.get?.security).toEqual([{ bearer: [] }]);
  });
});
