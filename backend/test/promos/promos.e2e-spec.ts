import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { buildOpenApiDocument } from '../../src/common/openapi';
import { createTestApp, type TestApp } from '../utils/app-factory';

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

const PROMO_ID = '01900000-0000-7000-8000-0000000000b1';
const EVENT_ID = '01900000-0000-7000-8000-0000000000e1';

describe('promos module HTTP surface (e2e, no database)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('documents every promos route with bearer security, 401/403 and a success response', () => {
    const operations = operationsUnder(buildOpenApiDocument(testApp.app), [
      '/api/v1/promos',
      '/api/v1/events',
      '/api/v1/admin/promos',
      '/api/v1/admin/coupon-templates',
      '/api/v1/admin/events',
    ]);
    expect(operations.size).toBe(29);
    for (const [name, operation] of operations) {
      expect({ name, secured: operation.security?.some((entry) => 'bearer' in entry) }).toEqual({
        name,
        secured: true,
      });
      expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '403']));
      expect(Object.keys(operation.responses).some((code) => code.startsWith('2'))).toBe(true);
    }
    for (const created of [
      'POST /api/v1/promos/{id}/claim',
      'POST /api/v1/events/{id}/register',
      'POST /api/v1/admin/promos',
      'POST /api/v1/admin/coupon-templates',
      'POST /api/v1/admin/events',
    ]) {
      expect(Object.keys(operations.get(created)?.responses ?? {})).toContain('201');
    }
  });

  it('keeps claims and registrations member-only and refuses admin or broken tokens on the poster', async () => {
    await request(testApp.server).post(`/api/v1/promos/${PROMO_ID}/claim`).expect(401);
    await request(testApp.server)
      .post(`/api/v1/events/${EVENT_ID}/register`)
      .send({ adults: 1 })
      .expect(401);
    await request(testApp.server).delete(`/api/v1/events/${EVENT_ID}/register`).expect(401);
    const admin = testApp.adminToken('01900000-0000-7000-8000-0000000000c0');
    await request(testApp.server)
      .get('/api/v1/promos')
      .set('Authorization', `Bearer ${admin}`)
      .expect(403);
    await request(testApp.server)
      .get(`/api/v1/events/${EVENT_ID}`)
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
  });

  it('documents the guest-readable routes as optional auth', () => {
    const document = buildOpenApiDocument(testApp.app);
    const optional = [
      '/api/v1/promos',
      '/api/v1/promos/{id}',
      '/api/v1/events',
      '/api/v1/events/{id}',
    ];
    for (const path of optional) {
      const operation = (document.paths[path] as Record<string, Record<string, unknown>>).get;
      expect({ path, auth: operation?.['x-auth'] }).toEqual({ path, auth: 'optional' });
    }
  });

  it('requires an Idempotency-Key for claims and registrations', async () => {
    const member = testApp.memberToken('01900000-0000-7000-8000-000000000001');
    const claim = await request(testApp.server)
      .post(`/api/v1/promos/${PROMO_ID}/claim`)
      .set('Authorization', `Bearer ${member}`)
      .expect(400);
    expect(claim.body).toMatchObject({ code: 'PC_COMMON_IDEMPOTENCY_KEY_REQUIRED' });
    await request(testApp.server)
      .post(`/api/v1/events/${EVENT_ID}/register`)
      .set('Authorization', `Bearer ${member}`)
      .send({ adults: 1 })
      .expect(400);
  });

  it('enforces back-office roles and validates bodies', async () => {
    const support = testApp.adminToken('01900000-0000-7000-8000-0000000000c1', ['support']);
    const manager = testApp.adminToken('01900000-0000-7000-8000-0000000000c2', ['manager']);
    await request(testApp.server)
      .post('/api/v1/admin/promos')
      .set('Authorization', `Bearer ${support}`)
      .send({})
      .expect(403);
    const invalid = await request(testApp.server)
      .post('/api/v1/admin/promos')
      .set('Authorization', `Bearer ${manager}`)
      .send({ title: '', kind: 'lottery', validFrom: 'tomorrow' })
      .expect(400);
    expect(invalid.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await request(testApp.server)
      .post(`/api/v1/admin/events/${EVENT_ID}/cancel`)
      .set('Authorization', `Bearer ${manager}`)
      .send({})
      .expect(400);
    await request(testApp.server)
      .get('/api/v1/admin/events/not-a-uuid')
      .set('Authorization', `Bearer ${support}`)
      .expect(400);
  });
});
