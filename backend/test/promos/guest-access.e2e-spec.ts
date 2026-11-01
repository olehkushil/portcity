import request from 'supertest';
import { EventsService } from '../../src/modules/promos/services/events.service';
import { PromosService } from '../../src/modules/promos/services/promos.service';
import { type TestApp, createTestApp } from '../utils/app-factory';

/**
 * Product decision: the promo list/detail and the event poster/detail are guest-readable
 * (`@OptionalAuth()`). Services are faked; the test checks the HTTP wiring: no token -> the
 * service gets no user, a member token -> the member id.
 */

const PROMO_ID = '01900000-0000-7000-8000-0000000000b1';
const EVENT_ID = '01900000-0000-7000-8000-0000000000e1';
const MEMBER = '01900000-0000-7000-8000-000000000001';

describe('guest access to promos and events (e2e)', () => {
  const promos = {
    listPublished: jest.fn(async () => ({ items: [], nextCursor: null })),
    getPublishedForMember: jest.fn(async (promoId: string, userId?: string) => ({
      id: promoId,
      claim: userId
        ? { allowed: true, code: null, detail: null, claimedByMe: 0 }
        : { allowed: false, code: 'PC_AUTH_REQUIRED', detail: 'Sign in', claimedByMe: 0 },
    })),
  };
  const events = {
    list: jest.fn(async () => ({ items: [], nextCursor: null })),
    getForMember: jest.fn(async (eventId: string, userId?: string) => ({
      id: eventId,
      registration: userId ? { status: 'active' } : null,
    })),
  };
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({
      configure: (builder) =>
        builder
          .overrideProvider(PromosService)
          .useValue(promos)
          .overrideProvider(EventsService)
          .useValue(events),
    });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('serves the promo list and detail without a token', async () => {
    await request(testApp.server).get('/api/v1/promos?category=fashion').expect(200);
    expect(promos.listPublished).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'fashion' }),
    );

    const detail = await request(testApp.server).get(`/api/v1/promos/${PROMO_ID}`).expect(200);
    expect(promos.getPublishedForMember).toHaveBeenLastCalledWith(PROMO_ID, undefined);
    expect(detail.body).toMatchObject({ claim: { allowed: false, code: 'PC_AUTH_REQUIRED' } });
  });

  it('passes the member to the services when a member token is sent', async () => {
    const auth = `Bearer ${testApp.memberToken(MEMBER)}`;
    await request(testApp.server)
      .get(`/api/v1/promos/${PROMO_ID}`)
      .set('Authorization', auth)
      .expect(200);
    expect(promos.getPublishedForMember).toHaveBeenLastCalledWith(PROMO_ID, MEMBER);

    const detail = await request(testApp.server)
      .get(`/api/v1/events/${EVENT_ID}`)
      .set('Authorization', auth)
      .expect(200);
    expect(events.getForMember).toHaveBeenLastCalledWith(EVENT_ID, MEMBER);
    expect(detail.body).toMatchObject({ registration: { status: 'active' } });
  });

  it('serves the event poster and detail to guests with registration = null', async () => {
    await request(testApp.server).get('/api/v1/events?category=kids&scope=upcoming').expect(200);
    expect(events.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'kids', scope: 'upcoming' }),
      undefined,
    );
    const detail = await request(testApp.server).get(`/api/v1/events/${EVENT_ID}`).expect(200);
    expect(events.getForMember).toHaveBeenLastCalledWith(EVENT_ID, undefined);
    expect(detail.body).toMatchObject({ registration: null });
  });

  it('validates the new category filters', async () => {
    await request(testApp.server).get('/api/v1/events?category=opera').expect(400);
    await request(testApp.server).get('/api/v1/promos?category=cars').expect(400);
  });
});
