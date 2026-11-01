import request from 'supertest';
import { createTestApp, type TestApp } from '../utils/app-factory';

describe('foundation smoke (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('GET /health answers outside the API prefix with a request id', async () => {
    const response = await request(testApp.server).get('/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', mode: 'api', service: 'portcity-backend' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('renders unknown routes as application/problem+json', async () => {
    const response = await request(testApp.server)
      .get('/api/v1/does-not-exist')
      .set('x-request-id', 'smoke-request-1')
      .expect(404);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.headers['x-request-id']).toBe('smoke-request-1');
    expect(response.body).toMatchObject({
      type: 'urn:portcity:problem:PC_COMMON_NOT_FOUND',
      status: 404,
      code: 'PC_COMMON_NOT_FOUND',
      requestId: 'smoke-request-1',
      instance: '/api/v1/does-not-exist',
    });
  });

  it('boots with in-memory queues and storage', () => {
    expect(testApp.config.QUEUE_DRIVER).toBe('memory');
    expect(testApp.queues.names()).toEqual(
      expect.arrayContaining(['maintenance', 'outbox-dispatch']),
    );
    expect(testApp.queues.getInMemory('outbox-dispatch').jobs).toHaveLength(0);
    expect(testApp.memberToken('user-1')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('GET /ready reports the database as unavailable when there is none', async () => {
    if (process.env.DATABASE_URL) {
      return;
    }
    const response = await request(testApp.server).get('/ready');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PC_COMMON_SERVICE_UNAVAILABLE');
  });
});
