import request from 'supertest';
import { FEATURE_FLAG_KEYS } from '../../src/common/contracts/admin';
import { PARKING_PORT } from '../../src/common/contracts/parking';
import { PAYMENTS_PORT } from '../../src/common/contracts/payments';
import { FeatureFlagsService } from '../../src/common/feature-flags/feature-flags.service';
import { buildOpenApiDocument } from '../../src/common/openapi/openapi';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { QUEUES } from '../../src/common/queue/queue.constants';
import { WorkerSchedules } from '../../src/common/queue/worker-schedules.service';
import { FakeClock } from '../../src/common/time/clock';
import { signParkingWebhook } from '../../src/modules/parking/provider/emulator.provider';
import { ParkingService } from '../../src/modules/parking/services/parking.service';
import { FakePaymentsPort } from '../../src/modules/parking/testing/fake-payments-port';
import { FakePrisma } from '../../src/modules/parking/testing/fake-prisma';
import { createTestApp, type TestApp } from '../utils/app-factory';

const USER = '0192f3a0-6c3e-7d2a-9c1b-0000000000a1';
const OTHER = '0192f3a0-6c3e-7d2a-9c1b-0000000000a2';
const THIRD = '0192f3a0-6c3e-7d2a-9c1b-0000000000a3';
const ADMIN = '0192f3a0-6c3e-7d2a-9c1b-0000000000ad';
const WEBHOOK_SECRET = 'dev-only-parking-webhook-secret';
/** 15:20 Kyiv on 2026-01-15: the emulator (scenario payable) reports 60 UAH due. */
const NOW = '2026-01-15T13:20:00.000Z';

/**
 * Parking inside the full AppModule: routes, guards, validation, idempotency, outbox routes,
 * schedules and the default emulator. Persistence is the module's in-memory FakePrisma and
 * payments are faked behind PAYMENTS_PORT, so no database is needed.
 */
describe('parking module (e2e)', () => {
  let testApp: TestApp;
  const clock = new FakeClock(NOW);
  const prisma = new FakePrisma(() => clock.now());
  const payments = new FakePaymentsPort(() => clock.now());
  const member = (userId = USER): string => `Bearer ${testApp.memberToken(userId)}`;

  beforeAll(async () => {
    testApp = await createTestApp({
      clock,
      configure: (builder) =>
        builder
          .overrideProvider(PrismaService)
          .useValue(prisma)
          .overrideProvider(PAYMENTS_PORT)
          .useValue(payments),
    });
    await prisma.featureFlag.create({
      data: { key: FEATURE_FLAG_KEYS.parkingInfoMode, enabled: false, updatedAt: clock.now() },
    });
    testApp.moduleRef.get(FeatureFlagsService, { strict: false }).invalidate();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('provides the real service under PARKING_PORT, its outbox routes and the sync schedule', () => {
    expect(testApp.moduleRef.get(PARKING_PORT, { strict: false })).toBeInstanceOf(ParkingService);
    const router = testApp.moduleRef.get(OutboxRouter, { strict: false });
    expect(router.resolve('payment.succeeded')).toContain(QUEUES.parkingEvents);
    expect(router.resolve('user.deleted')).toContain(QUEUES.parkingEvents);
    // Reminder events are consumed by notifications, not acknowledged by parking any more.
    expect(router.resolve('parking.session.free_ending')).not.toContain(QUEUES.parkingEvents);
    const schedules = testApp.moduleRef.get(WorkerSchedules, { strict: false }).list();
    expect(schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'parking-sync-every-minute',
          queue: QUEUES.parkingSync,
          every: 60_000,
        }),
      ]),
    );
  });

  it('documents every parking route in OpenAPI', () => {
    const document = buildOpenApiDocument(testApp.app);
    const paths = Object.keys(document.paths).filter(
      (path) => path.includes('parking') || path.includes('webhooks/parking'),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/parking/vehicles',
        '/api/v1/parking/vehicles/{id}',
        '/api/v1/parking/vehicles/{id}/verify',
        '/api/v1/parking/session',
        '/api/v1/parking/session/{id}/pay',
        '/api/v1/parking/session/{id}/left',
        '/api/v1/parking/history',
        '/api/v1/parking/tariff',
        '/api/v1/parking/quote',
        '/api/v1/parking/info/sessions',
        '/api/v1/parking/info/sessions/{id}/paid-at-paymat',
        '/api/v1/parking/info/sessions/{id}/exit',
        '/api/v1/webhooks/parking/{provider}',
        // Review findings 8-12.
        '/api/v1/parking/sessions/claim',
        '/api/v1/parking/session/{id}/still-here',
        '/api/v1/parking/session/{id}/dispute',
        '/api/v1/parking/history/summary',
        '/api/v1/parking/info/sessions/{id}',
      ]),
    );
    const timer = document.paths['/api/v1/parking/info/sessions/{id}'] as Record<string, unknown>;
    expect(Object.keys(timer).sort()).toEqual(['delete', 'patch']);
    const schemas = document.components?.schemas as Record<string, { properties?: object }>;
    expect(Object.keys(schemas['ParkingSessionDto']?.properties ?? {})).toEqual(
      expect.arrayContaining(['payNow', 'payments', 'presenceConfirmedAt']),
    );
    expect(Object.keys(schemas['ParkingHistoryItemDto']?.properties ?? {})).toEqual(
      expect.arrayContaining(['paidVia', 'paymentIds', 'disputed']),
    );
    expect(Object.keys(schemas['ParkingPaymentDto']?.properties ?? {})).toContain(
      'includesNextHour',
    );
    expect(Object.keys(schemas['VehicleDto']?.properties ?? {})).toContain('label');
  });

  it('registers the payments sweep next to the sync schedule', () => {
    const schedules = testApp.moduleRef.get(WorkerSchedules, { strict: false }).list();
    expect(schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'parking-payments-sweep',
          queue: QUEUES.parkingSync,
          jobName: 'payments-sweep',
          every: 300_000,
        }),
      ]),
    );
  });

  it('serves the tariff and the calculator without a token', async () => {
    const tariff = await request(testApp.server).get('/api/v1/parking/tariff');
    expect(tariff.status).toBe(200);
    expect(tariff.body).toMatchObject({
      version: 0,
      config: { freeMinutes: 30, firstHourKopecks: 2000, nextHourKopecks: 4000 },
      description: { hoursLine: 'Підземний 08:00–21:00 · Наземний 05:00–00:00' },
    });

    const quote = await request(testApp.server)
      .post('/api/v1/parking/quote')
      .send({ enteredAt: '2026-01-15T12:00:00.000Z' });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({
      amountDueKopecks: 6000,
      currentHourEndsAt: '2026-01-15T14:00:00.000Z',
      nextCharge: { startsAt: '2026-01-15T14:00:00.000Z', amountKopecks: 4000 },
      durationMinutes: 80,
    });

    const invalid = await request(testApp.server)
      .post('/api/v1/parking/quote')
      .send({ enteredAt: 'yesterday' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });

    const future = await request(testApp.server)
      .post('/api/v1/parking/quote')
      .send({ enteredAt: '2026-01-15T14:00:00.000Z' });
    expect(future.status).toBe(400);
  });

  it('guards member and admin routes', async () => {
    expect((await request(testApp.server).get('/api/v1/parking/session')).status).toBe(401);
    expect((await request(testApp.server).get('/api/v1/parking/vehicles')).status).toBe(401);
    const asMember = await request(testApp.server)
      .get('/api/v1/admin/parking/tariffs')
      .set('Authorization', member());
    expect(asMember.status).toBe(403);
    const asAdmin = await request(testApp.server)
      .get('/api/v1/admin/parking/tariffs')
      .set('Authorization', `Bearer ${testApp.adminToken(ADMIN)}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toEqual({ items: [] });
  });

  it('walks the member flow: add, verify, see 60 UAH due, pay idempotently, history', async () => {
    const empty = await request(testApp.server)
      .get('/api/v1/parking/session')
      .set('Authorization', member());
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ mode: 'full', heroState: 'F0', actions: ['add_vehicle'] });

    const added = await request(testApp.server)
      .post('/api/v1/parking/vehicles')
      .set('Authorization', member())
      .send({ plate: 'ас 1234 вс' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      plate: 'AC1234BC',
      plateDisplay: 'AC 1234 BC',
      verified: false,
    });
    const vehicleId = added.body.id as string;

    const duplicate = await request(testApp.server)
      .post('/api/v1/parking/vehicles')
      .set('Authorization', member())
      .send({ plate: 'AC1234BC' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers['content-type']).toContain('application/problem+json');

    // Unverified: only the amount and the paid period.
    const restricted = await request(testApp.server)
      .get('/api/v1/parking/session')
      .set('Authorization', member());
    expect(restricted.body).toMatchObject({
      heroState: 'F3',
      session: null,
      restricted: { plate: 'AC1234BC', amountDueKopecks: 6000, paidUntil: null },
      lookupQuota: { limit: 10, remaining: 9 },
    });

    const wrongCode = await request(testApp.server)
      .post(`/api/v1/parking/vehicles/${vehicleId}/verify`)
      .set('Authorization', member())
      .send({ talonCode: '0000' });
    expect(wrongCode.status).toBe(422);
    const verified = await request(testApp.server)
      .post(`/api/v1/parking/vehicles/${vehicleId}/verify`)
      .set('Authorization', member())
      .send({ talonCode: '771234' });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ verified: true, verifiedVia: 'talon' });

    const hero = await request(testApp.server)
      .get('/api/v1/parking/session')
      .set('Authorization', member());
    expect(hero.body).toMatchObject({
      heroState: 'F3',
      actions: ['pay', 'left'],
      session: {
        status: 'payable',
        plate: 'AC1234BC',
        zone: 'underground',
        level: '-2',
        spot: 'C',
        enteredAt: '2026-01-15T12:00:00.000Z',
        freeUntil: '2026-01-15T12:30:00.000Z',
        amountDueKopecks: 6000,
        currentHourEndsAt: '2026-01-15T14:00:00.000Z',
        lastSyncedAtLabel: '15:20',
      },
    });
    const sessionId = hero.body.session.id as string;

    const noKey = await request(testApp.server)
      .post(`/api/v1/parking/session/${sessionId}/pay`)
      .set('Authorization', member());
    expect(noKey.status).toBe(400);

    const paid = await request(testApp.server)
      .post(`/api/v1/parking/session/${sessionId}/pay`)
      .set('Authorization', member())
      .set('Idempotency-Key', 'pay-key-0001');
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({
      sessionId,
      amountKopecks: 6000,
      paidUntil: '2026-01-15T14:00:00.000Z',
      includesNextHour: false,
      payment: { status: 'created', amountKopecks: 6000 },
    });
    const replay = await request(testApp.server)
      .post(`/api/v1/parking/session/${sessionId}/pay`)
      .set('Authorization', member())
      .set('Idempotency-Key', 'pay-key-0001');
    expect(replay.status).toBe(201);
    expect(replay.body.payment.id).toBe(paid.body.payment.id);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const foreign = await request(testApp.server)
      .post(`/api/v1/parking/session/${sessionId}/left`)
      .set('Authorization', member(OTHER));
    expect(foreign.status).toBe(404);

    const history = await request(testApp.server)
      .get('/api/v1/parking/history')
      .set('Authorization', member());
    expect(history.status).toBe(200);
    expect(history.body.items).toEqual([
      expect.objectContaining({ id: sessionId, status: 'payable' }),
    ]);

    const badId = await request(testApp.server)
      .post('/api/v1/parking/session/not-a-uuid/left')
      .set('Authorization', member());
    expect(badId.status).toBe(400);
  });

  it('accepts signed operator webhooks and rejects bad signatures', async () => {
    const body = {
      eventId: 'evt-e2e-1',
      session: {
        providerRef: 'op-e2e',
        plate: 'KA0001KA',
        enteredAt: '2026-01-15T12:00:00.000Z',
      },
    };
    // The signature covers the exact bytes on the wire (rawBody), whitespace included.
    const wire = JSON.stringify(body, null, 2);
    const ok = await request(testApp.server)
      .post('/api/v1/webhooks/parking/emulator')
      .set('Content-Type', 'application/json')
      .set('X-Parking-Signature', signParkingWebhook(WEBHOOK_SECRET, wire))
      .send(wire);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      received: true,
      eventId: 'evt-e2e-1',
      tracked: false,
      duplicate: false,
    });
    // The same provider event id again is acknowledged without being applied (finding 7).
    const again = await request(testApp.server)
      .post('/api/v1/webhooks/parking/emulator')
      .set('Content-Type', 'application/json')
      .set('X-Parking-Signature', signParkingWebhook(WEBHOOK_SECRET, wire))
      .send(wire);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ eventId: 'evt-e2e-1', duplicate: true, changed: false });

    const bad = await request(testApp.server)
      .post('/api/v1/webhooks/parking/emulator')
      .set('X-Parking-Signature', 'sha256=00')
      .send(body);
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ code: 'PC_PARKING_WEBHOOK_SIGNATURE' });

    // A signature over a re-serialised body does not match the bytes actually sent.
    const reserialised = await request(testApp.server)
      .post('/api/v1/webhooks/parking/emulator')
      .set('Content-Type', 'application/json')
      .set('X-Parking-Signature', signParkingWebhook(WEBHOOK_SECRET, JSON.stringify(body)))
      .send(wire);
    expect(reserialised.status).toBe(401);

    const unknown = await request(testApp.server)
      .post('/api/v1/webhooks/parking/somebody')
      .send(body);
    expect(unknown.status).toBe(404);
  });

  it('runs the info-mode timer when the flag is on', async () => {
    await prisma.featureFlag.update({
      where: { key: FEATURE_FLAG_KEYS.parkingInfoMode },
      data: { enabled: true },
    });
    testApp.moduleRef.get(FeatureFlagsService, { strict: false }).invalidate();

    const started = await request(testApp.server)
      .post('/api/v1/parking/info/sessions')
      .set('Authorization', member(OTHER))
      .send({ zone: 'surface', enteredAt: '2026-01-15T12:00:00.000Z' });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      source: 'info_timer',
      status: 'payable',
      amountDueKopecks: 6000,
    });

    const invalid = await request(testApp.server)
      .post('/api/v1/parking/info/sessions')
      .set('Authorization', member(OTHER))
      .send({ zone: 'roof', enteredAt: '2026-01-15T12:00:00.000Z' });
    expect(invalid.status).toBe(400);

    const paid = await request(testApp.server)
      .post(`/api/v1/parking/info/sessions/${started.body.id as string}/paid-at-paymat`)
      .set('Authorization', member(OTHER))
      .send({});
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'paid', paidUntil: '2026-01-15T14:00:00.000Z' });

    const hero = await request(testApp.server)
      .get('/api/v1/parking/session')
      .set('Authorization', member(OTHER));
    expect(hero.body).toMatchObject({ mode: 'info', heroState: 'I3' });

    const exited = await request(testApp.server)
      .post(`/api/v1/parking/info/sessions/${started.body.id as string}/exit`)
      .set('Authorization', member(OTHER));
    expect(exited.status).toBe(200);
    expect(exited.body).toMatchObject({ status: 'closed', closedReason: 'user_exit' });
  });

  it('edits and discards an info-mode timer (finding 11)', async () => {
    const started = await request(testApp.server)
      .post('/api/v1/parking/info/sessions')
      .set('Authorization', member(OTHER))
      .send({ zone: 'surface', enteredAt: '2026-01-15T13:00:00.000Z' });
    expect(started.status).toBe(201);
    const id = started.body.id as string;

    const patched = await request(testApp.server)
      .patch(`/api/v1/parking/info/sessions/${id}`)
      .set('Authorization', member(OTHER))
      .send({ enteredAt: '2026-01-15T12:00:00.000Z', zone: 'underground' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      zone: 'underground',
      enteredAt: '2026-01-15T12:00:00.000Z',
      status: 'payable',
      amountDueKopecks: 6000,
    });
    const bad = await request(testApp.server)
      .patch(`/api/v1/parking/info/sessions/${id}`)
      .set('Authorization', member(OTHER))
      .send({ zone: 'roof' });
    expect(bad.status).toBe(400);

    const removed = await request(testApp.server)
      .delete(`/api/v1/parking/info/sessions/${id}`)
      .set('Authorization', member(OTHER));
    expect(removed.status).toBe(204);
    const again = await request(testApp.server)
      .delete(`/api/v1/parking/info/sessions/${id}`)
      .set('Authorization', member(OTHER));
    expect(again.status).toBe(404);
  });

  it('claims a talon session, confirms presence, disputes it and summarises the month (findings 8-10, 12)', async () => {
    const noKey = await request(testApp.server)
      .post('/api/v1/parking/sessions/claim')
      .set('Authorization', member(THIRD))
      .send({ talonCode: 'PC-0418227' });
    expect(noKey.status).toBe(400);
    const unknown = await request(testApp.server)
      .post('/api/v1/parking/sessions/claim')
      .set('Authorization', member(THIRD))
      .set('Idempotency-Key', 'claim-key-unknown')
      .send({ talonCode: 'PC-0000000' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'PC_PARKING_TALON_UNKNOWN' });

    const claimed = await request(testApp.server)
      .post('/api/v1/parking/sessions/claim')
      .set('Authorization', member(THIRD))
      .set('Idempotency-Key', 'claim-key-0001')
      .send({ talonCode: 'PC-0418227' });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      session: {
        plate: null,
        status: 'payable',
        amountDueKopecks: 6000,
        payNow: { amountKopecks: 6000, includesNextHour: false },
        payments: [],
      },
    });
    const sessionId = claimed.body.session.id as string;

    const stillHere = await request(testApp.server)
      .post(`/api/v1/parking/session/${sessionId}/still-here`)
      .set('Authorization', member(THIRD));
    expect(stillHere.status).toBe(200);
    expect(stillHere.body.session).toMatchObject({ presenceConfirmedAt: NOW });

    const invalidReason = await request(testApp.server)
      .post(`/api/v1/parking/session/${sessionId}/dispute`)
      .set('Authorization', member(THIRD))
      .send({ reason: 'aliens' });
    expect(invalidReason.status).toBe(400);
    const disputed = await request(testApp.server)
      .post(`/api/v1/parking/session/${sessionId}/dispute`)
      .set('Authorization', member(THIRD))
      .send({ reason: 'not_my_car', comment: 'Я не на паркінгу' });
    expect(disputed.status).toBe(200);
    expect(disputed.body.session).toBeNull();

    const summary = await request(testApp.server)
      .get('/api/v1/parking/history/summary?month=2026-01')
      .set('Authorization', member(USER));
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      month: '2026-01',
      from: '2025-12-31T22:00:00.000Z',
      visits: 1,
    });
    const badMonth = await request(testApp.server)
      .get('/api/v1/parking/history/summary?month=2026-1')
      .set('Authorization', member(USER));
    expect(badMonth.status).toBe(400);

    const history = await request(testApp.server)
      .get('/api/v1/parking/history?from=2026-01-15T00:00:00.000Z&to=2026-01-16T00:00:00.000Z')
      .set('Authorization', member(USER));
    expect(history.status).toBe(200);
    expect(history.body.items[0]).toMatchObject({ paidVia: 'none', disputed: false });
    expect(history.body.items[0].paymentIds).toEqual([]);
  });

  it('adds a vehicle with a label as the default one (finding 14)', async () => {
    const added = await request(testApp.server)
      .post('/api/v1/parking/vehicles')
      .set('Authorization', member(USER))
      .send({ plate: 'BC 0001 AA', label: 'Друга машина', makeDefault: true });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ label: 'Друга машина', isDefault: true, verified: false });
    const invalid = await request(testApp.server)
      .post('/api/v1/parking/vehicles')
      .set('Authorization', member(USER))
      .send({ plate: 'KA 0002 KA', makeDefault: 'yes' });
    expect(invalid.status).toBe(400);
  });
});
