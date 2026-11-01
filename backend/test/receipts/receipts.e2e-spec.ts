import request from 'supertest';
import { RECEIPTS_PORT, type ReceiptsPort } from '../../src/common/contracts/receipts';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { WorkerSchedules } from '../../src/common/queue/worker-schedules.service';
import { ReceiptsPortService } from '../../src/modules/receipts/services/receipts-port.service';
import {
  NoopTaxReceiptVerifier,
  TaxReceiptVerifierPort,
} from '../../src/modules/receipts/services/tax-receipt-verifier';
import { createTestApp, type TestApp } from '../utils/app-factory';

const USER_ID = '0192f3a0-1111-7000-8000-000000000001';
const DEVICE_ID = '0192f3a0-2222-7000-8000-000000000001';
const ADMIN_ID = '0192f3a0-3333-7000-8000-000000000001';
const RECEIPT_ID = '0192f3a0-6c3e-7d2a-9c1b-2f6d2c6a1e11';

/**
 * Wiring of the receipts module inside the full AppModule (no database): DI, routes, guards,
 * validation, the Idempotency-Key requirement and the photo upload flow (storage only).
 * Flows that touch PostgreSQL are covered by the service specs with in-memory fakes.
 */
describe('receipts module (e2e, no database)', () => {
  let testApp: TestApp;
  let member: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    member = testApp.memberToken(USER_ID, DEVICE_ID);
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('provides the real RECEIPTS_PORT and registers the sweep and verify schedules', () => {
    expect(testApp.moduleRef.get(RECEIPTS_PORT, { strict: false })).toBeInstanceOf(
      ReceiptsPortService,
    );
    const schedules = testApp.moduleRef.get(WorkerSchedules, { strict: false });
    expect(schedules.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'receipts-process-sweep',
          queue: 'receipts-process',
          jobName: 'sweep',
        }),
        expect.objectContaining({
          id: 'receipts-verify-held',
          queue: 'receipts-process',
          jobName: 'verify-held',
        }),
      ]),
    );
  });

  it('wires the noop tax checker and exposes getPendingSummary on the port', () => {
    expect(testApp.moduleRef.get(TaxReceiptVerifierPort, { strict: false })).toBeInstanceOf(
      NoopTaxReceiptVerifier,
    );
    const port = testApp.moduleRef.get<ReceiptsPort>(RECEIPTS_PORT, { strict: false });
    expect(typeof port.getPendingSummary).toBe('function');
  });

  it('requires the Idempotency-Key header on POST /receipts/manual', async () => {
    const response = await request(testApp.server)
      .post('/api/v1/receipts/manual')
      .set('Authorization', `Bearer ${member}`)
      .send({
        tenantId: null,
        fn: '4000100011',
        fiscalId: '1180000001',
        issuedAt: '2026-01-15T11:30:00',
        totalKopecks: 42_000,
        photoKey: `receipts/${USER_ID}/2026/01/0192f3a1-1111-7222-8333-444455556666.jpg`,
      })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'PC_COMMON_IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('validates the from/to filters of GET /receipts', async () => {
    const response = await request(testApp.server)
      .get('/api/v1/receipts?from=yesterday')
      .set('Authorization', `Bearer ${member}`)
      .expect(400);
    expect(response.body.code).toBe('PC_COMMON_VALIDATION');
  });

  it('consumes user.deleted on its own receipts-events queue', () => {
    const router = testApp.moduleRef.get(OutboxRouter, { strict: false });
    expect(router.resolve('user.deleted')).toContain('receipts-events');
    expect(testApp.queues.getInMemory('receipts-events').name).toBe('receipts-events');
  });

  it('validates the moderation reason filter of the admin queue', async () => {
    const admin = testApp.adminToken(ADMIN_ID, ['moderator']);
    const response = await request(testApp.server)
      .get('/api/v1/admin/receipts?status=needs_moderation&reason=sunspots')
      .set('Authorization', `Bearer ${admin}`)
      .expect(400);
    expect(response.body.code).toBe('PC_COMMON_VALIDATION');
  });

  it('requires a member token', async () => {
    await request(testApp.server).get('/api/v1/receipts').expect(401);
    await request(testApp.server)
      .post('/api/v1/receipts/qr')
      .send({ qrText: 'https://cabinet.tax.gov.ua/cashregs/check' })
      .expect(401);
  });

  it('requires the Idempotency-Key header on POST /receipts/qr', async () => {
    const response = await request(testApp.server)
      .post('/api/v1/receipts/qr')
      .set('Authorization', `Bearer ${member}`)
      .send({
        qrText:
          'https://cabinet.tax.gov.ua/cashregs/check?fn=4000100011&id=1&date=20260115&time=1200&sm=10.00',
      })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'PC_COMMON_IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('validates request bodies and ids', async () => {
    await request(testApp.server)
      .post('/api/v1/receipts/manual')
      .set('Authorization', `Bearer ${member}`)
      .send({ fn: '12', fiscalId: '1', issuedAt: 'yesterday', totalKopecks: 0, photoKey: 'x' })
      .expect(400);
    await request(testApp.server)
      .get('/api/v1/receipts/not-a-uuid')
      .set('Authorization', `Bearer ${member}`)
      .expect(400);
    await request(testApp.server)
      .post('/api/v1/receipts/photo-upload-url')
      .set('Authorization', `Bearer ${member}`)
      .send({ contentType: 'image/webp', sizeBytes: 1_000 })
      .expect(400);
  });

  it('issues a presigned photo upload scoped to the member', async () => {
    const response = await request(testApp.server)
      .post('/api/v1/receipts/photo-upload-url')
      .set('Authorization', `Bearer ${member}`)
      .send({ contentType: 'image/jpeg', sizeBytes: 245_000 })
      .expect(200);
    const body = response.body as { key: string; url: string; method: string; maxBytes: number };
    expect(body).toMatchObject({ method: 'PUT', maxBytes: 5 * 1024 * 1024 });
    expect(body.key).toMatch(new RegExp(`^receipts/${USER_ID}/\\d{4}/\\d{2}/.+\\.jpg$`));
    expect(body.url).toContain(body.key);

    const tooLarge = await request(testApp.server)
      .post('/api/v1/receipts/photo-upload-url')
      .set('Authorization', `Bearer ${member}`)
      .send({ contentType: 'image/jpeg', sizeBytes: 6 * 1024 * 1024 })
      .expect(422);
    expect(tooLarge.body).toMatchObject({ code: 'PC_RECEIPT_PHOTO_INVALID' });
  });

  it('guards the admin endpoints by principal type and role', async () => {
    await request(testApp.server)
      .get('/api/v1/admin/receipts')
      .set('Authorization', `Bearer ${member}`)
      .expect(403);
    await request(testApp.server)
      .post(`/api/v1/admin/receipts/${RECEIPT_ID}/reject`)
      .set('Authorization', `Bearer ${testApp.adminToken(ADMIN_ID, ['support'])}`)
      .send({ reason: 'Нечитабельне фото' })
      .expect(403);
    await request(testApp.server)
      .post(`/api/v1/admin/receipts/${RECEIPT_ID}/reject`)
      .set('Authorization', `Bearer ${testApp.adminToken(ADMIN_ID, ['moderator'])}`)
      .send({ reason: 'x' })
      .expect(400);
  });
});
