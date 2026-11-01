import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { buildOpenApiDocument } from '../../src/common/openapi';
import { OutboxRouter } from '../../src/common/outbox/outbox-router';
import { LogMailAdapter } from '../../src/modules/notifications/services/mail/log-mail.adapter';
import { MailPort } from '../../src/modules/notifications/services/mail/mail.port';
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

describe('notifications module HTTP surface (e2e, no database)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('documents every route with bearer security, 401/403 and a success response', () => {
    const operations = operationsUnder(buildOpenApiDocument(testApp.app), [
      '/api/v1/notifications',
      '/api/v1/admin/notifications',
    ]);
    expect([...operations.keys()].sort()).toEqual(
      [
        'GET /api/v1/admin/notifications',
        'GET /api/v1/admin/notifications/{id}',
        'GET /api/v1/notifications',
        'GET /api/v1/notifications/preferences',
        'GET /api/v1/notifications/unread-count',
        'POST /api/v1/admin/notifications',
        'POST /api/v1/notifications/read-all',
        'POST /api/v1/notifications/{id}/read',
        'PUT /api/v1/notifications/preferences',
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

  it('requires a member token for the inbox', async () => {
    await request(testApp.server).get('/api/v1/notifications').expect(401);
    await request(testApp.server).post('/api/v1/notifications/read-all').expect(401);
  });

  it('validates params and bodies', async () => {
    const member = testApp.memberToken('01900000-0000-7000-8000-000000000001');
    const auth = { Authorization: `Bearer ${member}` };
    await request(testApp.server)
      .post('/api/v1/notifications/not-a-uuid/read')
      .set(auth)
      .expect(400);
    const preferences = await request(testApp.server)
      .put('/api/v1/notifications/preferences')
      .set(auth)
      .send({ items: [{ kind: 'receipt_credited', enabled: 'nope' }] })
      .expect(400);
    expect(preferences.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await request(testApp.server).get('/api/v1/notifications?limit=1000').set(auth).expect(400);
  });

  it('wires the log mail adapter and routes the new event and support events', () => {
    expect(testApp.moduleRef.get(MailPort, { strict: false })).toBeInstanceOf(LogMailAdapter);
    const router = testApp.moduleRef.get(OutboxRouter, { strict: false });
    for (const type of ['event.published', 'event.registered', 'support.request_created']) {
      expect({ type, queues: router.resolve(type) }).toEqual({
        type,
        queues: expect.arrayContaining(['notifications-events']),
      });
    }
  });

  it('limits the admin send tool to managers and support', async () => {
    const moderator = testApp.adminToken('01900000-0000-7000-8000-0000000000c3', ['moderator']);
    const support = testApp.adminToken('01900000-0000-7000-8000-0000000000c1', ['support']);
    await request(testApp.server)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${moderator}`)
      .send({})
      .expect(403);
    const invalid = await request(testApp.server)
      .post('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${support}`)
      .send({ userId: 'nope', title: '', body: '' })
      .expect(400);
    expect(invalid.body).toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await request(testApp.server)
      .get('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${support}`)
      .expect(400);
  });
});
