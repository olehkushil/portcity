import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { buildOpenApiDocument } from '../../src/common/openapi';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { DEV_MOCK_WEBHOOK_SECRET } from '../../src/modules/payments/payments.config';
import { signMockWebhookBody } from '../../src/modules/payments/services/providers/mock-payment-provider';
import { createTestApp, type TestApp } from '../utils/app-factory';

/** test/setup-env.js does not set PAYMENTS_MOCK_WEBHOOK_SECRET, so the dev default applies. */
const MOCK_SECRET = process.env['PAYMENTS_MOCK_WEBHOOK_SECRET'] ?? DEV_MOCK_WEBHOOK_SECRET;

type Operation = {
  security?: Array<Record<string, unknown>>;
  responses: Record<string, unknown>;
};

function operationsUnder(document: OpenAPIObject, prefixes: string[]): Map<string, Operation> {
  const result = new Map<string, Operation>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (!prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      continue;
    }
    for (const [method, operation] of Object.entries(item as Record<string, Operation>)) {
      result.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return result;
}

const PUBLIC_ROUTES = new Set([
  'POST /api/v1/webhooks/payments/{provider}',
  'GET /api/v1/mock-checkout/{providerRef}',
  'POST /api/v1/mock-checkout/{providerRef}/complete',
]);

describe('payments module HTTP surface (e2e, no database)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('documents member and admin routes with bearer security and keeps provider routes public', () => {
    const operations = operationsUnder(buildOpenApiDocument(testApp.app), [
      '/api/v1/payments',
      '/api/v1/admin/payments',
      '/api/v1/webhooks/payments',
      '/api/v1/mock-checkout',
    ]);
    expect([...operations.keys()].sort()).toEqual(
      [
        'GET /api/v1/admin/payments',
        'GET /api/v1/admin/payments/{id}',
        'GET /api/v1/mock-checkout/{providerRef}',
        'GET /api/v1/payments',
        'GET /api/v1/payments/{id}',
        'POST /api/v1/admin/payments/{id}/reconcile',
        'POST /api/v1/admin/payments/{id}/refund',
        'POST /api/v1/mock-checkout/{providerRef}/complete',
        'POST /api/v1/webhooks/payments/{provider}',
      ].sort(),
    );
    for (const [name, operation] of operations) {
      const secured = operation.security?.some((entry) => 'bearer' in entry) ?? false;
      expect({ name, secured }).toEqual({ name, secured: !PUBLIC_ROUTES.has(name) });
      expect(Object.keys(operation.responses).some((code) => code.startsWith('2'))).toBe(true);
    }
  });

  it('documents the receipt screen fields of PaymentDto (finding 13)', () => {
    const document = buildOpenApiDocument(testApp.app);
    const schemas = document.components?.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(Object.keys(schemas['PaymentDto']?.properties ?? {})).toEqual(
      expect.arrayContaining(['displayNumber', 'merchantName', 'parking', 'operatorQrPayload']),
    );
    expect(Object.keys(schemas['PaymentParkingDto']?.properties ?? {}).sort()).toEqual(
      ['paidUntil', 'plateDisplay', 'sessionId'].sort(),
    );
  });

  it('rejects unsigned and tampered webhooks before any database work', async () => {
    const body = { event_id: 'evt-1', provider_ref: 'mock_x', status: 'succeeded' };
    const unsigned = await request(testApp.server)
      .post('/api/v1/webhooks/payments/mock')
      .send(body)
      .expect(401);
    expect(unsigned.body).toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE' });
    await request(testApp.server)
      .post('/api/v1/webhooks/payments/mock')
      .set('X-Mock-Signature', 'a'.repeat(64))
      .send(body)
      .expect(401);
    const unknown = await request(testApp.server)
      .post('/api/v1/webhooks/payments/stripe')
      .send(body)
      .expect(404);
    expect(unknown.body).toMatchObject({ code: 'PC_PAYMENT_PROVIDER_UNKNOWN' });
  });

  it('verifies the mock signature over the exact bytes received (rawBody)', async () => {
    const body = { event_id: 'evt-raw', provider_ref: 'mock_raw', status: 'succeeded' };
    const wire = JSON.stringify(body, null, 2);
    // Signed over a different serialisation of the same JSON: the raw bytes do not match.
    const reserialised = await request(testApp.server)
      .post('/api/v1/webhooks/payments/mock')
      .set('Content-Type', 'application/json')
      .set('X-Mock-Signature', signMockWebhookBody(MOCK_SECRET, JSON.stringify(body)))
      .send(wire);
    expect(reserialised.status).toBe(401);
    expect(reserialised.body).toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE' });

    // Signed over the exact bytes: the signature check passes (the unknown payment is answered
    // later by the database step: 404 with PostgreSQL, an error without it).
    const exact = await request(testApp.server)
      .post('/api/v1/webhooks/payments/mock')
      .set('Content-Type', 'application/json')
      .set('X-Mock-Signature', signMockWebhookBody(MOCK_SECRET, wire))
      .send(wire);
    expect(exact.status).not.toBe(401);
    expect(exact.body).not.toMatchObject({ code: 'PC_PAYMENT_WEBHOOK_SIGNATURE' });
  });

  it('consumes user.deleted on its own events queue', () => {
    const router = testApp.app.get(OutboxRouter);
    expect(router.resolve('user.deleted')).toContain('payments-events');
  });

  it('serves the dev mock checkout route (404 for an unknown checkout)', async () => {
    const page = await request(testApp.server)
      .get('/api/v1/mock-checkout/mock_unknown')
      .expect(404);
    expect(page.body).toMatchObject({ code: 'PC_PAYMENT_NOT_FOUND' });
    await request(testApp.server)
      .post('/api/v1/mock-checkout/mock_unknown/complete')
      .send({ outcome: 'teleported' })
      .expect(400);
  });

  it('guards member and admin routes', async () => {
    await request(testApp.server).get('/api/v1/payments').expect(401);
    const member = testApp.memberToken('01900000-0000-7000-8000-000000000001');
    await request(testApp.server)
      .get('/api/v1/payments/not-a-uuid')
      .set('Authorization', `Bearer ${member}`)
      .expect(400);
    await request(testApp.server)
      .get('/api/v1/admin/payments')
      .set('Authorization', `Bearer ${member}`)
      .expect(403);
    const support = testApp.adminToken('01900000-0000-7000-8000-0000000000c1', ['support']);
    await request(testApp.server)
      .post('/api/v1/admin/payments/01900000-0000-7000-8000-0000000000aa/refund')
      .set('Authorization', `Bearer ${support}`)
      .set('Idempotency-Key', 'refund-0001')
      .send({ reason: 'Тест' })
      .expect(403);
  });
});
