import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT } from '../../src/common/contracts/admin';
import { CLUB_LEDGER_PORT } from '../../src/common/contracts/club';
import { CONTENT_PORT } from '../../src/common/contracts/content';
import { PARKING_PORT } from '../../src/common/contracts/parking';
import { VOUCHER_CODE_PATTERN, VOUCHER_ISSUER_PORT } from '../../src/common/contracts/rewards';
import type { BeginResult } from '../../src/common/idempotency/idempotency.service';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WorkerSchedules } from '../../src/common/queue/worker-schedules.service';
import { FakeClock } from '../../src/common/time/clock';
import { RewardsRepository } from '../../src/modules/rewards/services/rewards.repository';
import { VoucherService } from '../../src/modules/rewards/services/voucher.service';
import { type TestApp, createTestApp } from '../utils/app-factory';
import {
  FakeAudit,
  FakeContent,
  FakeLedger,
  FakeOutbox,
  FakeParking,
  FakeRewardsPrisma,
} from './support/fakes';
import { InMemoryRewardsRepository } from './support/in-memory-rewards.repository';

/** In-memory Idempotency-Key store with the protocol of IdempotencyService. */
class FakeIdempotency {
  private readonly rows = new Map<string, { hash: string; status?: number; response?: unknown }>();

  async begin(scope: string, key: string, requestHash: string): Promise<BeginResult> {
    const row = this.rows.get(`${scope}#${key}`);
    if (!row) {
      this.rows.set(`${scope}#${key}`, { hash: requestHash });
      return { kind: 'proceed' };
    }
    if (row.hash !== requestHash) {
      return { kind: 'mismatch' };
    }
    return row.status === undefined
      ? { kind: 'in_progress' }
      : { kind: 'replay', status: row.status, response: row.response };
  }

  async complete(scope: string, key: string, status: number, response: unknown): Promise<void> {
    const row = this.rows.get(`${scope}#${key}`);
    if (row) {
      row.status = status;
      row.response = response;
    }
  }

  async abandon(scope: string, key: string): Promise<void> {
    this.rows.delete(`${scope}#${key}`);
  }
}

const API = '/api/v1';

describe('rewards module (e2e on in-memory fakes)', () => {
  const clock = new FakeClock('2026-11-01T10:00:00.000Z');
  const repo = new InMemoryRewardsRepository(() => clock.now());
  const outbox = new FakeOutbox();
  const ledger = new FakeLedger(() => clock.now());
  const content = new FakeContent();
  const parking = new FakeParking();
  const audit = new FakeAudit();
  const prisma = new FakeRewardsPrisma([repo, outbox, ledger, audit]);
  const member = uuidv7();
  let testApp: TestApp;
  let memberAuth: string;
  let ownerAuth: string;

  beforeAll(async () => {
    testApp = await createTestApp({
      clock,
      configure: (builder) =>
        builder
          .overrideProvider(PrismaService)
          .useValue(prisma)
          .overrideProvider(RewardsRepository)
          .useValue(repo)
          .overrideProvider(OutboxService)
          .useValue(outbox)
          .overrideProvider(IdempotencyService)
          .useValue(new FakeIdempotency())
          .overrideProvider(CLUB_LEDGER_PORT)
          .useValue(ledger)
          .overrideProvider(CONTENT_PORT)
          .useValue(content)
          .overrideProvider(PARKING_PORT)
          .useValue(parking)
          .overrideProvider(ADMIN_AUDIT_PORT)
          .useValue(audit),
    });
    memberAuth = `Bearer ${testApp.memberToken(member, uuidv7())}`;
    ownerAuth = `Bearer ${testApp.adminToken(uuidv7(), ['owner'])}`;
    ledger.setBalance(member, 320);
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe('wiring', () => {
    it('provides VOUCHER_ISSUER_PORT with VoucherService', () => {
      expect(testApp.moduleRef.get(VOUCHER_ISSUER_PORT, { strict: false })).toBeInstanceOf(
        VoucherService,
      );
    });

    it('registers the minute vouchers-expire schedule and its queues', () => {
      const schedules = testApp.moduleRef.get(WorkerSchedules, { strict: false }).list();
      expect(schedules).toContainEqual(
        expect.objectContaining({
          id: 'vouchers-expire-every-minute',
          queue: 'vouchers-expire',
          jobName: 'expire',
          every: 60_000,
        }),
      );
      expect(testApp.queues.names()).toEqual(
        expect.arrayContaining(['vouchers-expire', 'rewards-events']),
      );
    });

    it('routes the consumed outbox events to rewards-events', () => {
      const router = testApp.moduleRef.get(OutboxRouter, { strict: false });
      expect(router.resolve('event.registration_cancelled')).toContain('rewards-events');
      expect(router.resolve('user.deleted')).toContain('rewards-events');
    });
  });

  describe('member catalogue and wallet', () => {
    function seedReward(title: string, costPoints: number, sortOrder: number): void {
      repo.putReward({
        id: uuidv7(),
        title,
        description: null,
        costPoints,
        kind: 'partner',
        tenantId: null,
        stock: null,
        perUserLimit: null,
        active: true,
        validFrom: null,
        validTo: null,
        imageKey: null,
        terms: null,
        sortOrder,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
    }

    beforeAll(() => {
      seedReward('Кава з собою', 60, 1);
      seedReward('Квиток у кіно', 450, 2);
    });

    it('is guest-readable: no token gives the catalogue with per-user fields null', async () => {
      const guest = await request(testApp.server).get(`${API}/rewards`).expect(200);
      expect(guest.body.items.map((item: { title: string }) => item.title)).toEqual([
        'Кава з собою',
        'Квиток у кіно',
      ]);
      expect(
        guest.body.items.map((item: { affordable: unknown; remainingForUser: unknown }) => [
          item.affordable,
          item.remainingForUser,
        ]),
      ).toEqual([
        [null, null],
        [null, null],
      ]);
      expect(guest.body.items[0]).toHaveProperty('imageUrl', null);

      const id = guest.body.items[0].id as string;
      const detail = await request(testApp.server).get(`${API}/rewards/${id}`).expect(200);
      expect(detail.body).toMatchObject({ id, affordable: null });

      // A token that is sent is still verified; an admin token is not a member.
      const bad = await request(testApp.server)
        .get(`${API}/rewards`)
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
      expect(bad.body.code).toMatch(/^PC_AUTH_/);
      await request(testApp.server)
        .get(`${API}/rewards`)
        .set('Authorization', ownerAuth)
        .expect(403);
      // Redeeming still needs a member.
      await request(testApp.server)
        .post(`${API}/rewards/${id}/redeem`)
        .set('Idempotency-Key', 'guest-redeem-0001')
        .expect(401);
    });

    it('lists the catalogue with affordability and filters affordable=true', async () => {
      const all = await request(testApp.server)
        .get(`${API}/rewards`)
        .set('Authorization', memberAuth)
        .expect(200);
      expect(all.body.items.map((item: { title: string }) => item.title)).toEqual([
        'Кава з собою',
        'Квиток у кіно',
      ]);
      expect(all.body.items.map((item: { affordable: boolean }) => item.affordable)).toEqual([
        true,
        false,
      ]);
      const affordable = await request(testApp.server)
        .get(`${API}/rewards?affordable=true&limit=10`)
        .set('Authorization', memberAuth)
        .expect(200);
      expect(affordable.body.items).toHaveLength(1);
    });

    it('validates path and query parameters', async () => {
      await request(testApp.server)
        .get(`${API}/rewards/not-a-uuid`)
        .set('Authorization', memberAuth)
        .expect(400);
      const bad = await request(testApp.server)
        .get(`${API}/rewards?affordable=maybe`)
        .set('Authorization', memberAuth)
        .expect(400);
      expect(bad.body.code).toBe('PC_COMMON_VALIDATION');
      await request(testApp.server)
        .get(`${API}/vouchers?status=used`)
        .set('Authorization', memberAuth)
        .expect(400);
    });

    it('requires Idempotency-Key to redeem and replays a repeated request', async () => {
      const coffee = repo.rewards.find((reward) => reward.title === 'Кава з собою')!;
      const missing = await request(testApp.server)
        .post(`${API}/rewards/${coffee.id}/redeem`)
        .set('Authorization', memberAuth)
        .expect(400);
      expect(missing.body.code).toBe('PC_COMMON_IDEMPOTENCY_KEY_REQUIRED');

      const first = await request(testApp.server)
        .post(`${API}/rewards/${coffee.id}/redeem`)
        .set('Authorization', memberAuth)
        .set('Idempotency-Key', 'redeem-coffee-0001')
        .expect(201);
      expect(first.body).toMatchObject({
        pointsSpent: 60,
        availableBalance: 260,
        voucher: { status: 'issued', kind: 'reward', title: 'Кава з собою' },
        redemption: { status: 'issued', rewardId: coffee.id },
      });

      const replay = await request(testApp.server)
        .post(`${API}/rewards/${coffee.id}/redeem`)
        .set('Authorization', memberAuth)
        .set('Idempotency-Key', 'redeem-coffee-0001')
        .expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.voucher.id).toBe(first.body.voucher.id);
      expect(ledger.balanceOf(member)).toBe(260);
    });

    it('answers 422 PC_POINTS_INSUFFICIENT when the balance is too low', async () => {
      const cinema = repo.rewards.find((reward) => reward.title === 'Квиток у кіно')!;
      const response = await request(testApp.server)
        .post(`${API}/rewards/${cinema.id}/redeem`)
        .set('Authorization', memberAuth)
        .set('Idempotency-Key', 'redeem-cinema-0001')
        .expect(422);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body.code).toBe('PC_POINTS_INSUFFICIENT');
    });
  });

  describe('counter flow: activation, validator shift, redemption, log', () => {
    let voucherId: string;
    let deviceKey: string;
    let shiftToken: string;
    let code: string;
    let token: string;

    it('admin registers a mall validator device and receives the key once', async () => {
      const short = await request(testApp.server)
        .post(`${API}/admin/validator-devices`)
        .set('Authorization', ownerAuth)
        .send({ name: 'Інфостійка', pin: '2468' })
        .expect(400);
      expect(short.body.code).toBe('PC_COMMON_VALIDATION');

      const response = await request(testApp.server)
        .post(`${API}/admin/validator-devices`)
        .set('Authorization', ownerAuth)
        .send({ name: 'Інфостійка', pin: '246813' })
        .expect(201);
      expect(response.body.device).toMatchObject({
        name: 'Інфостійка',
        tenantId: null,
        active: true,
      });
      expect(response.body.device.pinHash).toBeUndefined();
      expect(response.body.device.deviceKeyHash).toBeUndefined();
      deviceKey = response.body.deviceKey as string;
      expect(deviceKey.length).toBeGreaterThan(30);
      expect(audit.actions()).toContain('validator_device.create');
    });

    it('member lists vouchers and activates one', async () => {
      const list = await request(testApp.server)
        .get(`${API}/vouchers?status=issued`)
        .set('Authorization', memberAuth)
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      voucherId = list.body.items[0].id as string;
      expect(list.body.items[0]).toMatchObject({
        tenant: null,
        imageUrl: null,
        qrPayload: null,
      });
      expect(list.body.items[0].displayNumber).toMatch(/^\d{8}$/);

      const summary = await request(testApp.server)
        .get(`${API}/vouchers/summary`)
        .set('Authorization', memberAuth)
        .expect(200);
      expect(summary.body).toEqual({
        counts: { issued: 1, active: 0, redeemed: 0, expired: 0, cancelled: 0 },
        live: 1,
        total: 1,
      });
      const several = await request(testApp.server)
        .get(`${API}/vouchers?status=issued,active`)
        .set('Authorization', memberAuth)
        .expect(200);
      expect(several.body.items).toHaveLength(1);

      const activation = await request(testApp.server)
        .post(`${API}/vouchers/${voucherId}/activate`)
        .set('Authorization', memberAuth)
        .expect(200);
      expect(activation.body.code).toMatch(VOUCHER_CODE_PATTERN);
      expect(activation.body.activationExpiresAt).toBe('2026-11-01T10:02:00.000Z');
      expect(activation.body.voucher.status).toBe('active');
      code = activation.body.code as string;
      token = activation.body.token as string;
    });

    it('validator endpoints require the device key and a shift proof', async () => {
      const noKey = await request(testApp.server).get(`${API}/validator/me`).expect(401);
      expect(noKey.body.code).toBe('PC_VALIDATOR_UNAUTHORIZED');
      const noShift = await request(testApp.server)
        .get(`${API}/validator/me`)
        .set('X-Validator-Key', deviceKey)
        .expect(401);
      expect(noShift.body.code).toBe('PC_VALIDATOR_PIN_REQUIRED');
      const wrongPin = await request(testApp.server)
        .post(`${API}/validator/shift`)
        .set('X-Validator-Key', deviceKey)
        .send({ pin: '0000' })
        .expect(401);
      expect(wrongPin.body.code).toBe('PC_VALIDATOR_PIN_INVALID');
      expect(wrongPin.body.details).toEqual({ attemptsLeft: 4 });
      // The PIN is accepted only by POST /validator/shift.
      const pinHeader = await request(testApp.server)
        .get(`${API}/validator/me`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Pin', '246813')
        .expect(401);
      expect(pinHeader.body.code).toBe('PC_VALIDATOR_PIN_REQUIRED');
    });

    it('opens a shift with the PIN', async () => {
      const response = await request(testApp.server)
        .post(`${API}/validator/shift`)
        .set('X-Validator-Key', deviceKey)
        .send({ pin: '246813' })
        .expect(200);
      expect(response.body.expiresAt).toBe('2026-11-01T22:00:00.000Z');
      shiftToken = response.body.shiftToken as string;
      const me = await request(testApp.server)
        .get(`${API}/validator/me`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .expect(200);
      expect(me.body).toMatchObject({ name: 'Інфостійка', authMethod: 'shift', tenantId: null });
    });

    it('redeems the activated voucher by code exactly once', async () => {
      clock.advanceSeconds(20);
      const redeemed = await request(testApp.server)
        .post(`${API}/validator/redeem`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .send({ code: code.toLowerCase() })
        .expect(200);
      expect(redeemed.body).toMatchObject({
        outcome: 'redeemed',
        voucher: { id: voucherId, status: 'redeemed' },
        device: { authMethod: 'shift' },
      });
      expect(outbox.types()).toContain('voucher.redeemed');

      const again = await request(testApp.server)
        .post(`${API}/validator/redeem`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .send({ token })
        .expect(409);
      expect(again.body.code).toBe('PC_VOUCHER_ALREADY_REDEEMED');

      await request(testApp.server)
        .post(`${API}/validator/redeem`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .send({})
        .expect(400);
    });

    it('redeems a certificate by its static offline QR, once', async () => {
      const issued = await request(testApp.server)
        .post(`${API}/admin/vouchers`)
        .set('Authorization', ownerAuth)
        .set('Idempotency-Key', 'admin-issue-cert-0001')
        .send({
          userId: member,
          kind: 'certificate',
          title: 'Подарункова карта 200 ₴',
          expiresAt: '2026-12-31T21:59:59.000Z',
        })
        .expect(201);
      const detail = await request(testApp.server)
        .get(`${API}/vouchers/${issued.body.id as string}`)
        .set('Authorization', memberAuth)
        .expect(200);
      const qr = detail.body.qrPayload as string;
      expect(qr).toMatch(/^PCV1:/);

      const redeemed = await request(testApp.server)
        .post(`${API}/validator/redeem`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .send({ token: qr })
        .expect(200);
      expect(redeemed.body.voucher).toMatchObject({
        id: issued.body.id,
        status: 'redeemed',
        qrPayload: null,
      });
      const again = await request(testApp.server)
        .post(`${API}/validator/redeem`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .send({ token: qr })
        .expect(409);
      expect(again.body.code).toBe('PC_VOUCHER_ALREADY_REDEEMED');
      expect(JSON.stringify(again.body)).not.toContain(issued.body.id as string);
    });

    it('shows the attempts in the device log (validator and back office)', async () => {
      const log = await request(testApp.server)
        .get(`${API}/validator/log?limit=10`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .expect(200);
      expect(log.body.items.map((row: { outcome: string }) => row.outcome)).toEqual([
        'already_redeemed',
        'redeemed',
        'already_redeemed',
        'redeemed',
      ]);
      expect(log.body.items[0].ip).toBeUndefined();

      const deviceId = repo.devices[0]!.id;
      const adminLog = await request(testApp.server)
        .get(`${API}/admin/validator-devices/${deviceId}/log`)
        .set('Authorization', ownerAuth)
        .expect(200);
      expect(adminLog.body.items).toHaveLength(4);
      expect(adminLog.body.items[0]).toHaveProperty('voucherId');
    });

    it('locks shift opening after 5 wrong PINs (429) and a new PIN clears it', async () => {
      const deviceId = repo.devices[0]!.id;
      const codes: number[] = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await request(testApp.server)
          .post(`${API}/validator/shift`)
          .set('X-Validator-Key', deviceKey)
          .send({ pin: '000000' });
        codes.push(response.status);
      }
      // One wrong PIN was already counted in the earlier test; the successful shift reset it.
      expect(codes).toEqual([401, 401, 401, 401, 429]);
      const locked = await request(testApp.server)
        .post(`${API}/validator/shift`)
        .set('X-Validator-Key', deviceKey)
        .send({ pin: '246813' })
        .expect(429);
      expect(locked.body).toMatchObject({
        code: 'PC_VALIDATOR_PIN_LOCKED',
        details: { lockedUntil: expect.any(String) as unknown },
      });
      expect(audit.actions()).toContain('validator_device.pin_locked');

      await request(testApp.server)
        .post(`${API}/admin/validator-devices/${deviceId}/pin`)
        .set('Authorization', ownerAuth)
        .send({ pin: '135792' })
        .expect(200);
      const reopened = await request(testApp.server)
        .post(`${API}/validator/shift`)
        .set('X-Validator-Key', deviceKey)
        .send({ pin: '135792' })
        .expect(200);
      shiftToken = reopened.body.shiftToken as string;
    });

    it('a revoked device stops working immediately', async () => {
      const deviceId = repo.devices[0]!.id;
      await request(testApp.server)
        .post(`${API}/admin/validator-devices/${deviceId}/revoke?reason=lost`)
        .set('Authorization', ownerAuth)
        .expect(200);
      const response = await request(testApp.server)
        .get(`${API}/validator/me`)
        .set('X-Validator-Key', deviceKey)
        .set('X-Validator-Shift', shiftToken)
        .expect(403);
      expect(response.body.code).toBe('PC_VALIDATOR_INACTIVE');
    });
  });

  describe('cancellation and back office', () => {
    it('member cancels a voucher with Idempotency-Key and gets the points back', async () => {
      const coffee = repo.rewards.find((reward) => reward.title === 'Кава з собою')!;
      const redeemed = await request(testApp.server)
        .post(`${API}/rewards/${coffee.id}/redeem`)
        .set('Authorization', memberAuth)
        .set('Idempotency-Key', 'redeem-coffee-0002')
        .expect(201);
      const voucherId = redeemed.body.voucher.id as string;
      const before = ledger.balanceOf(member) ?? 0;

      await request(testApp.server)
        .post(`${API}/vouchers/${voucherId}/cancel`)
        .set('Authorization', memberAuth)
        .send({ reason: 'changed my mind' })
        .expect(400);
      const cancelled = await request(testApp.server)
        .post(`${API}/vouchers/${voucherId}/cancel`)
        .set('Authorization', memberAuth)
        .set('Idempotency-Key', 'cancel-voucher-0001')
        .send({ reason: 'changed my mind' })
        .expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      expect(ledger.balanceOf(member)).toBe(before + 60);

      const detail = await request(testApp.server)
        .get(`${API}/vouchers/${voucherId}`)
        .set('Authorization', memberAuth)
        .expect(200);
      expect(detail.body.status).toBe('cancelled');
    });

    it('foreign vouchers read as not found', async () => {
      const other = `Bearer ${testApp.memberToken(uuidv7())}`;
      const voucherId = repo.vouchers[0]!.id;
      const response = await request(testApp.server)
        .get(`${API}/vouchers/${voucherId}`)
        .set('Authorization', other)
        .expect(404);
      expect(response.body.code).toBe('PC_VOUCHER_NOT_FOUND');
    });

    it('admin endpoints check the role', async () => {
      await request(testApp.server)
        .get(`${API}/admin/rewards`)
        .set('Authorization', memberAuth)
        .expect(403);
      const moderator = `Bearer ${testApp.adminToken(uuidv7(), ['moderator'])}`;
      await request(testApp.server)
        .get(`${API}/admin/rewards`)
        .set('Authorization', moderator)
        .expect(403);
      const support = `Bearer ${testApp.adminToken(uuidv7(), ['support'])}`;
      await request(testApp.server)
        .get(`${API}/admin/vouchers`)
        .set('Authorization', support)
        .expect(200);
      await request(testApp.server)
        .post(`${API}/admin/vouchers`)
        .set('Authorization', support)
        .set('Idempotency-Key', 'admin-issue-0001')
        .send({ userId: member, kind: 'reward', title: 'Кава' })
        .expect(403);
    });

    it('admin manages the catalogue', async () => {
      const created = await request(testApp.server)
        .post(`${API}/admin/rewards`)
        .set('Authorization', ownerAuth)
        .send({ title: 'Попкорн у Premier City', costPoints: 80, kind: 'partner', stock: 10 })
        .expect(201);
      const id = created.body.id as string;
      await request(testApp.server)
        .patch(`${API}/admin/rewards/${id}`)
        .set('Authorization', ownerAuth)
        .send({ costPoints: 90 })
        .expect(200)
        .expect(({ body }) => expect(body.costPoints).toBe(90));
      await request(testApp.server)
        .delete(`${API}/admin/rewards/${id}?reason=season`)
        .set('Authorization', ownerAuth)
        .expect(200)
        .expect(({ body }) => expect(body.active).toBe(false));
      const list = await request(testApp.server)
        .get(`${API}/admin/rewards?active=false`)
        .set('Authorization', ownerAuth)
        .expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toContain(id);
      expect(audit.actions()).toEqual(
        expect.arrayContaining(['reward.create', 'reward.update', 'reward.deactivate']),
      );
    });

    it('admin issues and lists vouchers', async () => {
      const issued = await request(testApp.server)
        .post(`${API}/admin/vouchers`)
        .set('Authorization', ownerAuth)
        .set('Idempotency-Key', 'admin-issue-0002')
        .send({
          userId: member,
          kind: 'certificate',
          title: 'Подарункова карта 200 ₴',
          reason: 'complaint',
        })
        .expect(201);
      expect(issued.body).toMatchObject({
        sourceType: 'admin',
        kind: 'certificate',
        status: 'issued',
      });
      const list = await request(testApp.server)
        .get(`${API}/admin/vouchers?userId=${member}&kind=certificate&status=issued`)
        .set('Authorization', ownerAuth)
        .expect(200);
      // The certificate redeemed by its static QR earlier is filtered out by status.
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([issued.body.id]);
    });
  });
});
