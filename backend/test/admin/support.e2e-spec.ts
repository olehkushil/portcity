import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import type { BeginResult } from '../../src/common/idempotency/idempotency.service';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { buildOpenApiDocument } from '../../src/common/openapi';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { SupportRequestsService } from '../../src/modules/admin/services/support-requests.service';
import { type TestApp, createTestApp } from '../utils/app-factory';

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

/** In-memory Idempotency-Key store (no database in e2e). */
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

  async complete(scope: string, key: string, status: number, response: unknown): Promise<boolean> {
    const row = this.rows.get(`${scope}#${key}`);
    if (row) {
      row.status = status;
      row.response = response;
    }
    return row !== undefined;
  }

  async abandon(scope: string, key: string): Promise<void> {
    this.rows.delete(`${scope}#${key}`);
  }
}

const MEMBER = '01900000-0000-7000-8000-000000000001';
const REQUEST_ID = '01900000-0000-7000-8000-0000000005a1';

describe('support requests HTTP surface (e2e, service faked)', () => {
  const support = {
    create: jest.fn(async () => ({ id: REQUEST_ID, number: 1042 })),
    listMine: jest.fn(async () => ({ items: [], nextCursor: null })),
    createPhotoUpload: jest.fn(async () => ({
      url: 'memory://upload',
      method: 'PUT',
      headers: {},
      key: `support/${MEMBER}/2026/11/a.jpg`,
      expiresAt: new Date('2026-11-01T10:10:00.000Z'),
    })),
    listForAdmin: jest.fn(async () => ({ items: [], nextCursor: null })),
    getForAdmin: jest.fn(async (id: string) => ({ id, number: 1042 })),
    update: jest.fn(async (id: string) => ({ id, status: 'resolved' })),
  };
  let testApp: TestApp;
  let memberAuth: string;

  beforeAll(async () => {
    testApp = await createTestApp({
      configure: (builder) =>
        builder
          .overrideProvider(SupportRequestsService)
          .useValue(support)
          .overrideProvider(IdempotencyService)
          .useValue(new FakeIdempotency()),
    });
    memberAuth = `Bearer ${testApp.memberToken(MEMBER)}`;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('documents the member and back-office routes with bearer security', () => {
    const operations = operationsUnder(buildOpenApiDocument(testApp.app), [
      '/api/v1/support/requests',
      '/api/v1/admin/support-requests',
    ]);
    expect([...operations.keys()].sort()).toEqual(
      [
        'GET /api/v1/admin/support-requests',
        'GET /api/v1/admin/support-requests/{id}',
        'GET /api/v1/support/requests',
        'PATCH /api/v1/admin/support-requests/{id}',
        'POST /api/v1/support/requests',
        'POST /api/v1/support/requests/photo-upload-url',
      ].sort(),
    );
    for (const [name, operation] of operations) {
      expect({ name, secured: operation.security?.some((entry) => 'bearer' in entry) }).toEqual({
        name,
        secured: true,
      });
      expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '403']));
    }
    expect(Object.keys(operations.get('POST /api/v1/support/requests')?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '429']),
    );
  });

  it('creates a request for the member with an Idempotency-Key and returns the number', async () => {
    const body = { topic: 'receipt', message: 'Бали за чек не нараховано' };
    await request(testApp.server)
      .post('/api/v1/support/requests')
      .set('Authorization', memberAuth)
      .send(body)
      .expect(400);
    const created = await request(testApp.server)
      .post('/api/v1/support/requests')
      .set('Authorization', memberAuth)
      .set('Idempotency-Key', 'support-key-0001')
      .send(body)
      .expect(201);
    expect(created.body).toEqual({ id: REQUEST_ID, number: 1042 });
    expect(support.create).toHaveBeenCalledWith(MEMBER, expect.objectContaining(body));
    await request(testApp.server)
      .get('/api/v1/support/requests')
      .set('Authorization', memberAuth)
      .expect(200);
    expect(support.listMine).toHaveBeenCalledWith(MEMBER, expect.objectContaining({ limit: 20 }));
  });

  it('validates the request body', async () => {
    const invalid = await request(testApp.server)
      .post('/api/v1/support/requests')
      .set('Authorization', memberAuth)
      .set('Idempotency-Key', 'support-key-0002')
      .send({ topic: 'wifi', message: 'x', photoKey: '../etc/passwd', extra: true })
      .expect(400);
    expect(invalid.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await request(testApp.server)
      .post('/api/v1/support/requests/photo-upload-url')
      .set('Authorization', memberAuth)
      .send({ contentType: 'application/pdf', sizeBytes: 10 })
      .expect(400);
  });

  it('keeps the member routes for members and the back office for support and managers', async () => {
    await request(testApp.server).get('/api/v1/support/requests').expect(401);
    const support1 = testApp.adminToken('01900000-0000-7000-8000-0000000000c1', ['support']);
    const moderator = testApp.adminToken('01900000-0000-7000-8000-0000000000c3', ['moderator']);
    await request(testApp.server)
      .get('/api/v1/support/requests')
      .set('Authorization', `Bearer ${support1}`)
      .expect(403);
    await request(testApp.server)
      .get('/api/v1/admin/support-requests')
      .set('Authorization', memberAuth)
      .expect(403);
    await request(testApp.server)
      .get('/api/v1/admin/support-requests')
      .set('Authorization', `Bearer ${moderator}`)
      .expect(403);
    await request(testApp.server)
      .get('/api/v1/admin/support-requests?status=new')
      .set('Authorization', `Bearer ${support1}`)
      .expect(200);
    expect(support.listForAdmin).toHaveBeenCalledWith(
      { status: 'new', userId: undefined },
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('updates a request with status and note and validates the body', async () => {
    const manager = testApp.adminToken('01900000-0000-7000-8000-0000000000c2', ['manager']);
    const auth = { Authorization: `Bearer ${manager}` };
    await request(testApp.server)
      .patch(`/api/v1/admin/support-requests/${REQUEST_ID}`)
      .set(auth)
      .send({ status: 'done' })
      .expect(400);
    await request(testApp.server)
      .patch('/api/v1/admin/support-requests/not-a-uuid')
      .set(auth)
      .send({ status: 'resolved' })
      .expect(400);
    await request(testApp.server)
      .patch(`/api/v1/admin/support-requests/${REQUEST_ID}`)
      .set(auth)
      .send({ status: 'resolved', note: 'Бали нараховано вручну' })
      .expect(200);
    expect(support.update).toHaveBeenCalledWith(
      REQUEST_ID,
      { status: 'resolved', note: 'Бали нараховано вручну' },
      expect.objectContaining({ id: '01900000-0000-7000-8000-0000000000c2' }),
    );
  });

  it('routes support.request_created to the notifications consumer', () => {
    const router = testApp.moduleRef.get(OutboxRouter, { strict: false });
    expect(router.resolve('support.request_created')).toContain('notifications-events');
    expect(router.resolve('event.published')).toContain('notifications-events');
  });
});
