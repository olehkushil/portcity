import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminGuard, MemberGuard, RolesGuard } from '../../../common/auth/guards';
import { TokenService } from '../../../common/auth/token.service';
import { APP_CONFIG, getValidatedEnv } from '../../../common/config';
import { ADMIN_AUDIT_PORT } from '../../../common/contracts/admin';
import { IDENTITY_PORT } from '../../../common/contracts/identity';
import { ProblemDetailsFilter } from '../../../common/errors/problem-details.filter';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { Clock } from '../../../common/time/clock';
import { createValidationPipe } from '../../../common/validation/validation.pipe';
import { ClubAccountService } from '../services/club-account.service';
import { ClubRepository } from '../services/club.repository';
import { LedgerService } from '../services/ledger.service';
import { RuleSetsService } from '../services/rule-sets.service';
import { type ClubTestKit, createClubTestKit } from '../testing/club-test-kit';
import { AdminClubAccountsController, AdminRuleSetsController } from './admin-club.controller';
import { ClubController } from './club.controller';

const USER = '0192f3a0-6c3e-7d2a-9c1b-000000000001';
const ADMIN = '0192f3a0-6c3e-7d2a-9c1b-0000000000ad';

/**
 * HTTP contract of the club controllers (routing, guards, validation, problem+json) on a small
 * Nest app with the in-memory repository; the full AppModule is covered by the e2e suite.
 */
describe('club controllers (HTTP)', () => {
  let kit: ClubTestKit;
  let app: INestApplication;
  let server: Server;
  let tokens: TokenService;

  const member = (userId = USER): string =>
    `Bearer ${tokens.signAccessToken({ sub: userId, type: 'member' }).token}`;
  const admin = (roles: string[] = ['manager']): string =>
    `Bearer ${tokens.signAccessToken({ sub: ADMIN, type: 'admin', roles }).token}`;

  beforeEach(async () => {
    kit = createClubTestKit('2026-11-01T10:00:00.000Z');
    const moduleRef = await Test.createTestingModule({
      controllers: [ClubController, AdminRuleSetsController, AdminClubAccountsController],
      providers: [
        { provide: APP_CONFIG, useValue: getValidatedEnv() },
        { provide: Clock, useValue: kit.clock },
        TokenService,
        MemberGuard,
        AdminGuard,
        RolesGuard,
        { provide: ClubRepository, useValue: kit.repo },
        { provide: RuleSetsService, useValue: kit.ruleSets },
        { provide: LedgerService, useValue: kit.ledger },
        { provide: ClubAccountService, useValue: kit.accounts },
        { provide: OutboxService, useValue: kit.outbox },
        { provide: ADMIN_AUDIT_PORT, useValue: kit.audit },
        { provide: IDENTITY_PORT, useValue: kit.identity },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
    server = app.getHttpServer() as Server;
    tokens = app.get(TokenService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /club/account', () => {
    it('requires a member token', async () => {
      const response = await request(server).get('/api/v1/club/account');
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({ code: 'PC_AUTH_UNAUTHORIZED' });

      const asAdmin = await request(server)
        .get('/api/v1/club/account')
        .set('Authorization', admin());
      expect(asAdmin.status).toBe(403);
    });

    it('returns the card of the authenticated member', async () => {
      kit.identity.add(USER, '734211800');
      await kit.accounts.grantWelcome(USER, 'register');

      const response = await request(server)
        .get('/api/v1/club/account')
        .set('Authorization', member());

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        balance: 50,
        pending: 0,
        lifetimeEarned: 50,
        memberCode: '734211800',
        newcomerLockUntil: '2026-11-04T10:00:00.000Z',
        spendBlockedBy: 'newcomer_lock',
        expiringSoon: { withinDays: 30, points: 0, nearest: null },
        pointValueKopecks: 100,
      });
      expect(response.body.qrPayload).toMatch(/^PC1:734211800:[0-9a-f]{8}$/);
    });
  });

  describe('GET /club/transactions', () => {
    it('pages the member history and validates the query', async () => {
      for (let index = 1; index <= 3; index += 1) {
        await kit.ledger.credit({
          userId: USER,
          amount: index * 10,
          sourceType: 'receipt',
          idempotencyKey: `receipt:${index}`,
        });
        kit.clock.advanceMinutes(1);
      }

      const first = await request(server)
        .get('/api/v1/club/transactions?limit=2')
        .set('Authorization', member());
      expect(first.status).toBe(200);
      expect(first.body.items.map((item: { amount: number }) => item.amount)).toEqual([30, 20]);
      expect(first.body.items[0]).not.toHaveProperty('idempotencyKey');
      expect(typeof first.body.nextCursor).toBe('string');

      const second = await request(server)
        .get('/api/v1/club/transactions')
        .query({ limit: 2, cursor: first.body.nextCursor as string })
        .set('Authorization', member());
      expect(second.body).toMatchObject({ items: [{ amount: 10 }], nextCursor: null });

      const invalid = await request(server)
        .get('/api/v1/club/transactions?type=bogus&limit=1000')
        .set('Authorization', member());
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    });
  });

  describe('GET /club/transactions (window) and /club/transactions/summary', () => {
    it('filters by from/to and validates the dates', async () => {
      await kit.ledger.credit({
        userId: USER,
        amount: 10,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:1',
      });
      kit.clock.set('2026-11-05T10:00:00.000Z');
      await kit.ledger.credit({
        userId: USER,
        amount: 20,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:2',
        title: 'Нарахування за чек',
        subtitle: 'INTERTOP',
        counterparty: { tenantName: 'INTERTOP', receiptTotalKopecks: 66_700 },
      });

      const windowed = await request(server)
        .get('/api/v1/club/transactions')
        .query({ from: '2026-11-03T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z' })
        .set('Authorization', member());
      expect(windowed.status).toBe(200);
      expect(windowed.body.items).toEqual([
        expect.objectContaining({
          amount: 20,
          title: 'Нарахування за чек',
          subtitle: 'INTERTOP',
          counterparty: { tenantName: 'INTERTOP', receiptTotalKopecks: 66_700 },
        }),
      ]);

      const all = await request(server)
        .get('/api/v1/club/transactions')
        .set('Authorization', member());
      // A row posted without caller display data gets the title derived from its type.
      expect(all.body.items[1]).toMatchObject({
        amount: 10,
        title: 'Нарахування за чек',
        subtitle: null,
        counterparty: null,
      });

      const invalid = await request(server)
        .get('/api/v1/club/transactions?from=yesterday')
        .set('Authorization', member());
      expect(invalid.status).toBe(400);
      const reversed = await request(server)
        .get('/api/v1/club/transactions')
        .query({ from: '2026-11-06T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z' })
        .set('Authorization', member());
      expect(reversed.status).toBe(400);
    });

    it('summarises a month for the member', async () => {
      await kit.ledger.credit({
        userId: USER,
        amount: 90,
        sourceType: 'receipt',
        idempotencyKey: 'receipt:1',
      });
      const response = await request(server)
        .get('/api/v1/club/transactions/summary?month=2026-11')
        .set('Authorization', member());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        month: '2026-11',
        from: '2026-10-31T22:00:00.000Z',
        to: '2026-11-30T22:00:00.000Z',
        earned: 90,
        spent: 0,
        expired: 0,
        refunded: 0,
        reversed: 0,
      });
      const current = await request(server)
        .get('/api/v1/club/transactions/summary')
        .set('Authorization', member());
      expect(current.body.month).toBe('2026-11');

      expect(
        (
          await request(server)
            .get('/api/v1/club/transactions/summary?month=2026-1')
            .set('Authorization', member())
        ).status,
      ).toBe(400);
      expect(
        (await request(server).get('/api/v1/club/transactions/summary?month=2026-11')).status,
      ).toBe(401);
    });

    it('adds pendingModeration to the card', async () => {
      kit.identity.add(USER, '734211800');
      kit.ports.receipts = {
        getPendingSummary: async () => ({ count: 1, expectedPoints: 180 }),
      };
      const response = await request(server)
        .get('/api/v1/club/account')
        .set('Authorization', member());
      expect(response.body.pendingModeration).toEqual({ count: 1, expectedPoints: 180 });
    });
  });

  describe('OpenAPI security', () => {
    it('documents /club/rules without a security requirement and the member routes with bearer', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      );
      const rules = document.paths['/api/v1/club/rules']?.get;
      expect(rules).toBeDefined();
      expect(rules?.security ?? []).toEqual([]);
      for (const path of [
        '/api/v1/club/account',
        '/api/v1/club/transactions',
        '/api/v1/club/transactions/summary',
      ]) {
        expect(document.paths[path]?.get?.security).toEqual([{ bearer: [] }]);
      }
    });
  });

  describe('GET /club/rules', () => {
    it('is public and hides the auto-approve threshold', async () => {
      const response = await request(server).get('/api/v1/club/rules');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        version: 0,
        baseRatePercent: 3,
        pointsTtlMonths: 12,
        welcome: { register: 50, profile: 30, firstReceipt: 20 },
        expiryReminderDays: [30, 7],
      });
      expect(response.body).not.toHaveProperty('autoApproveThresholdKopecks');
    });
  });

  describe('/admin/club/rule-sets', () => {
    it('creates a version for a manager and lists it', async () => {
      const created = await request(server)
        .post('/api/v1/admin/club/rule-sets')
        .set('Authorization', admin(['manager']))
        .send({ config: { baseRatePercent: 4, welcome: { register: 70 } }, note: 'v1' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        version: 1,
        active: true,
        note: 'v1',
        createdById: ADMIN,
        config: {
          baseRatePercent: 4,
          autoApproveThresholdKopecks: 100000,
          welcome: { register: 70, profile: 30, firstReceipt: 20 },
        },
      });

      const list = await request(server)
        .get('/api/v1/admin/club/rule-sets')
        .set('Authorization', admin(['support']));
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);

      const one = await request(server)
        .get(`/api/v1/admin/club/rule-sets/${created.body.id as string}`)
        .set('Authorization', admin(['support']));
      expect(one.body).toMatchObject({ version: 1 });

      const rules = await request(server).get('/api/v1/club/rules');
      expect(rules.body).toMatchObject({ version: 1, baseRatePercent: 4 });
    });

    it('forbids creation for read-only roles and members', async () => {
      const support = await request(server)
        .post('/api/v1/admin/club/rule-sets')
        .set('Authorization', admin(['support']))
        .send({});
      expect(support.status).toBe(403);

      const asMember = await request(server)
        .get('/api/v1/admin/club/rule-sets')
        .set('Authorization', member());
      expect(asMember.status).toBe(403);
    });

    it('validates the body strictly', async () => {
      const response = await request(server)
        .post('/api/v1/admin/club/rule-sets')
        .set('Authorization', admin())
        .send({ config: { baseRatePercent: 300, unknownKey: 1 }, activeFrom: 'tomorrow' });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    });

    it('edits and deletes a scheduled version', async () => {
      const created = await request(server)
        .post('/api/v1/admin/club/rule-sets')
        .set('Authorization', admin())
        .send({ activeFrom: '2026-12-01T00:00:00.000Z' });
      const id = created.body.id as string;
      expect(created.body.active).toBe(false);

      const patched = await request(server)
        .patch(`/api/v1/admin/club/rule-sets/${id}`)
        .set('Authorization', admin())
        .send({ config: { holdDays: 3 }, note: null });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ config: { holdDays: 3 }, note: null });

      const removed = await request(server)
        .delete(`/api/v1/admin/club/rule-sets/${id}?reason=test`)
        .set('Authorization', admin());
      expect(removed.status).toBe(204);

      const missing = await request(server)
        .get(`/api/v1/admin/club/rule-sets/${id}`)
        .set('Authorization', admin());
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: 'PC_RULESET_NOT_FOUND' });

      const badId = await request(server)
        .get('/api/v1/admin/club/rule-sets/not-a-uuid')
        .set('Authorization', admin());
      expect(badId.status).toBe(400);
    });
  });

  describe('/admin/club/accounts/:userId', () => {
    it('shows the account and the ledger with idempotency keys', async () => {
      await kit.accounts.grantWelcome(USER, 'register');

      const account = await request(server)
        .get(`/api/v1/admin/club/accounts/${USER}`)
        .set('Authorization', admin(['support']));
      expect(account.status).toBe(200);
      expect(account.body).toMatchObject({
        userId: USER,
        available: 50,
        welcomeState: { register: true, profile: false, firstReceipt: false },
        buckets: [{ expiresOn: '2027-11-01', remaining: 50 }],
      });

      const ledger = await request(server)
        .get(`/api/v1/admin/club/accounts/${USER}/transactions`)
        .set('Authorization', admin(['support']));
      expect(ledger.body.items[0]).toMatchObject({
        type: 'welcome',
        idempotencyKey: `welcome:register:${USER}`,
      });

      const unknown = await request(server)
        .get('/api/v1/admin/club/accounts/0192f3a0-6c3e-7d2a-9c1b-0000000000ff')
        .set('Authorization', admin(['support']));
      expect(unknown.status).toBe(404);
    });
  });
});
