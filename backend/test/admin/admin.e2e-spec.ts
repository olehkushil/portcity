import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { buildOpenApiDocument } from '../../src/common/openapi';
import { createTestApp, type TestApp } from '../utils/app-factory';

const ADMIN_PATHS = [
  '/api/v1/admin/adjustments',
  '/api/v1/admin/audit',
  '/api/v1/admin/feature-flags',
  '/api/v1/admin/reports',
];

type Operation = {
  security?: Array<Record<string, unknown>>;
  responses: Record<string, unknown>;
};

function operationsUnder(document: OpenAPIObject, prefixes: string[]): Array<[string, Operation]> {
  const result: Array<[string, Operation]> = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) {
      continue;
    }
    for (const [method, operation] of Object.entries(item as Record<string, Operation>)) {
      result.push([`${method.toUpperCase()} ${path}`, operation]);
    }
  }
  return result;
}

const ADJUSTMENT_ID = '01900000-0000-7000-8000-000000000a01';

describe('admin module HTTP surface (e2e, no database)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('documents every admin route with bearer security, 401/403 and a success response', () => {
    const operations = operationsUnder(buildOpenApiDocument(testApp.app), ADMIN_PATHS);
    expect(operations.map(([name]) => name).sort()).toEqual(
      [
        'DELETE /api/v1/admin/feature-flags/{key}',
        'GET /api/v1/admin/adjustments',
        'GET /api/v1/admin/adjustments/{id}',
        'GET /api/v1/admin/audit',
        'GET /api/v1/admin/audit/{id}',
        'GET /api/v1/admin/feature-flags',
        'GET /api/v1/admin/feature-flags/{key}',
        'GET /api/v1/admin/reports/daily',
        'GET /api/v1/admin/reports/daily/range',
        'POST /api/v1/admin/adjustments',
        'POST /api/v1/admin/adjustments/{id}/apply',
        'POST /api/v1/admin/adjustments/{id}/approve',
        'POST /api/v1/admin/adjustments/{id}/reject',
        'POST /api/v1/admin/reports/daily/recompute',
        'PUT /api/v1/admin/feature-flags/{key}',
      ].sort(),
    );
    for (const [name, operation] of operations) {
      expect({ name, secured: operation.security?.some((entry) => 'bearer' in entry) }).toEqual({
        name,
        secured: true,
      });
      expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '403']));
      expect(Object.keys(operation.responses).some((code) => code.startsWith('2'))).toBe(true);
    }
  });

  it('rejects anonymous and member callers', async () => {
    await request(testApp.server).get('/api/v1/admin/adjustments').expect(401);
    const member = testApp.memberToken('01900000-0000-7000-8000-000000000001');
    const response = await request(testApp.server)
      .get('/api/v1/admin/audit')
      .set('Authorization', `Bearer ${member}`)
      .expect(403);
    expect(response.body).toMatchObject({ code: 'PC_AUTH_FORBIDDEN' });
  });

  it('enforces roles: support may not approve an adjustment (four eyes is a manager decision)', async () => {
    const support = testApp.adminToken('01900000-0000-7000-8000-0000000000c1', ['support']);
    await request(testApp.server)
      .post(`/api/v1/admin/adjustments/${ADJUSTMENT_ID}/approve`)
      .set('Authorization', `Bearer ${support}`)
      .set('Idempotency-Key', 'approve-0001')
      .expect(403);
  });

  it('requires an Idempotency-Key on adjustment requests', async () => {
    const manager = testApp.adminToken('01900000-0000-7000-8000-0000000000c2', ['manager']);
    const response = await request(testApp.server)
      .post('/api/v1/admin/adjustments')
      .set('Authorization', `Bearer ${manager}`)
      .send({ userId: ADJUSTMENT_ID, amount: 100, reason: 'Компенсація' })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'PC_COMMON_IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('validates params, queries and bodies before touching the database', async () => {
    const owner = testApp.adminToken('01900000-0000-7000-8000-0000000000c0');
    const auth = { Authorization: `Bearer ${owner}` };

    await request(testApp.server).get('/api/v1/admin/adjustments/not-a-uuid').set(auth).expect(400);
    const badStatus = await request(testApp.server)
      .get('/api/v1/admin/adjustments?status=done')
      .set(auth)
      .expect(400);
    expect(badStatus.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await request(testApp.server)
      .post(`/api/v1/admin/adjustments/${ADJUSTMENT_ID}/reject`)
      .set(auth)
      .send({ reason: 'x' })
      .expect(400);
    await request(testApp.server)
      .put('/api/v1/admin/feature-flags/parking.info_mode')
      .set(auth)
      .send({ enabled: 'yes', unexpected: true })
      .expect(400);
    await request(testApp.server).get('/api/v1/admin/audit?actorType=robot').set(auth).expect(400);
  });
});
