import { FEATURE_FLAG_KEYS } from '../../../common/contracts/admin';
import { PARKING_EVENTS } from '../../../common/contracts/events';
import { EMULATOR_TALON_REF } from '../provider/emulator.provider';
import { snapshot } from '../testing/fake-parking-provider';
import { OTHER_USER_ID, ParkingHarness, USER_ID } from '../testing/parking-harness';
import { CLAIMS_PER_HOUR } from './sessions.service';

const at = ParkingHarness.at;

async function fullMode(provider: 'fake' | 'emulator' = 'fake'): Promise<ParkingHarness> {
  const h = new ParkingHarness({ provider, scenario: 'payable' });
  await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
  return h;
}

describe('SessionsService.claimByTalon (finding 8)', () => {
  it('attaches the talon-only emulator session (plate null) and returns the hero', async () => {
    const h = await fullMode('emulator');
    h.setTime('15:20');
    const hero = await h.sessions.claimByTalon(USER_ID, ' pc-0418227 ');
    expect(hero).toMatchObject({
      heroState: 'F3',
      actions: ['pay', 'left'],
      session: { plate: null, status: 'payable', amountDueKopecks: 6000 },
    });
    expect(h.sessionsRows()).toEqual([
      expect.objectContaining({
        providerRef: EMULATOR_TALON_REF,
        userId: USER_ID,
        vehicleId: null,
        plate: null,
      }),
    ]);
    expect(h.events()).toContain(PARKING_EVENTS.sessionOpened);

    // The claimed talon session can be paid in the app.
    const payment = await h.payments.pay(USER_ID, hero.session!.id);
    expect(payment.payment.meta).toMatchObject({ plate: null, plateDisplay: null });
    expect(h.paymentsPort.createCalls[0]?.description).toContain('талон');

    // Claiming again is harmless; another member cannot take it.
    await expect(h.sessions.claimByTalon(USER_ID, 'PC-0418227')).resolves.toMatchObject({
      heroState: 'F3',
    });
    await expect(h.sessions.claimByTalon(OTHER_USER_ID, 'PC-0418227')).rejects.toMatchObject({
      code: 'PC_PARKING_SESSION_CLAIMED',
      status: 409,
    });
  });

  it('answers 404 for an unknown talon, 400 for a malformed one and 503 when the operator is down', async () => {
    const h = await fullMode();
    h.setTime('15:20');
    await expect(h.sessions.claimByTalon(USER_ID, 'PC!1')).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
    });
    await expect(h.sessions.claimByTalon(USER_ID, 'PC-9999999')).rejects.toMatchObject({
      code: 'PC_PARKING_TALON_UNKNOWN',
      status: 404,
    });
    h.fakeProvider.failWith = new Error('operator down');
    await expect(h.sessions.claimByTalon(USER_ID, 'PC-9999999')).rejects.toMatchObject({
      code: 'PC_PARKING_PROVIDER_UNAVAILABLE',
      status: 503,
    });
  });

  it('links the member vehicle when the talon session has the member plate, refuses another account plate', async () => {
    const h = await fullMode();
    h.setTime('15:20');
    const own = await h.addVehicle(USER_ID, 'AC1234BC', { verified: false });
    h.fakeProvider.setTalon(
      'T-1001',
      snapshot({ providerRef: 'op-t1', enteredAt: at('14:00'), plate: 'AC1234BC' }),
    );
    await h.sessions.claimByTalon(USER_ID, 'T-1001');
    expect(h.sessionsRows()[0]).toMatchObject({ userId: USER_ID, vehicleId: own.id });

    await h.addVehicle(OTHER_USER_ID, 'BC0001AA', { verified: true });
    h.fakeProvider.setTalon(
      'T-1002',
      snapshot({ providerRef: 'op-t2', enteredAt: at('14:00'), plate: 'BC0001AA' }),
    );
    await expect(h.sessions.claimByTalon(USER_ID, 'T-1002')).rejects.toMatchObject({
      code: 'PC_PARKING_SESSION_CLAIMED',
    });
  });

  it(`allows ${CLAIMS_PER_HOUR} claims per member per hour`, async () => {
    const h = await fullMode();
    h.setTime('15:20');
    for (let index = 0; index < CLAIMS_PER_HOUR; index += 1) {
      await expect(h.sessions.claimByTalon(USER_ID, 'PC-0000001')).rejects.toMatchObject({
        code: 'PC_PARKING_TALON_UNKNOWN',
      });
    }
    await expect(h.sessions.claimByTalon(USER_ID, 'PC-0000001')).rejects.toMatchObject({
      code: 'PC_PARKING_CLAIM_LIMIT',
      status: 429,
    });
    await expect(h.sessions.claimByTalon(OTHER_USER_ID, 'PC-0000001')).rejects.toMatchObject({
      code: 'PC_PARKING_TALON_UNKNOWN',
    });
    h.setTime('16:21');
    await expect(h.sessions.claimByTalon(USER_ID, 'PC-0000001')).rejects.toMatchObject({
      code: 'PC_PARKING_TALON_UNKNOWN',
    });
  });
});

describe('SessionsService.confirmPresence (finding 9)', () => {
  it('«Так, я тут» moves the F7 threshold and the still_inside reminder', async () => {
    const h = await fullMode();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.fakeProvider.set(snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }));
    h.setTime('19:05');
    const f7 = await h.sessions.getHero(USER_ID);
    expect(f7.heroState).toBe('F7');
    expect(f7.actions).toEqual(['pay', 'confirm_present', 'left']);

    const hero = await h.sessions.confirmPresence(USER_ID, f7.session!.id);
    expect(hero.heroState).toBe('F3');
    expect(hero.session?.presenceConfirmedAt).toEqual(at('19:05'));

    // The next still_inside reminder comes five hours after the confirmation.
    const reminders = (): number => h.eventPayloads(PARKING_EVENTS.sessionStillInside).length;
    const before = reminders();
    h.setTime('23:30');
    await h.sessions.getHero(USER_ID);
    expect(reminders()).toBe(before);
    h.clock.set(new Date(at('19:05').getTime() + 5 * 3_600_000 + 60_000));
    const later = await h.sessions.getHero(USER_ID);
    expect(later.heroState).toBe('F7');
    expect(reminders()).toBe(before + 1);
  });

  it('refuses closed sessions and other members’ sessions', async () => {
    const h = await fullMode();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.fakeProvider.set(snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }));
    h.setTime('15:20');
    const hero = await h.sessions.getHero(USER_ID);
    await expect(h.sessions.confirmPresence(OTHER_USER_ID, hero.session!.id)).rejects.toMatchObject(
      { code: 'PC_PARKING_SESSION_NOT_FOUND' },
    );
    await h.sessions.markLeft(USER_ID, hero.session!.id);
    await expect(h.sessions.confirmPresence(USER_ID, hero.session!.id)).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
    });
  });
});

describe('SessionsService.dispute (finding 10)', () => {
  it('«Це не моє авто» hides the session, publishes parking.session.disputed once and keeps it in the history', async () => {
    const h = await fullMode();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.fakeProvider.set(snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }));
    h.setTime('14:10');
    const f2 = await h.sessions.getHero(USER_ID);
    expect(f2.heroState).toBe('F2');

    const hero = await h.sessions.dispute(USER_ID, f2.session!.id, {
      reason: 'not_my_car',
      comment: ' Моя машина вдома ',
    });
    expect(hero).toMatchObject({ heroState: 'F1', session: null });
    expect(h.eventPayloads(PARKING_EVENTS.sessionDisputed)).toEqual([
      expect.objectContaining({
        sessionId: f2.session!.id,
        userId: USER_ID,
        reason: 'not_my_car',
        comment: 'Моя машина вдома',
        disputedAt: at('14:10').toISOString(),
      }),
    ]);
    await h.sessions.dispute(USER_ID, f2.session!.id, { reason: 'wrong_amount' });
    expect(h.eventPayloads(PARKING_EVENTS.sessionDisputed)).toHaveLength(1);

    // Still hidden after the next operator refresh; no reminders for it.
    h.setTime('14:27');
    const later = await h.sessions.getHero(USER_ID);
    expect(later.session).toBeNull();
    expect(h.eventPayloads(PARKING_EVENTS.sessionFreeEnding)).toHaveLength(0);
    await expect(h.parking.getSessionForUser(USER_ID)).resolves.toBeNull();
    const history = await h.sessions.history(USER_ID, { limit: 10 });
    expect(history.items).toEqual([expect.objectContaining({ disputed: true })]);
    await expect(h.parking.listForAdmin({ disputed: true, limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: f2.session!.id })],
    });
  });
});

describe('SessionsService history and payments (finding 12)', () => {
  it('lists linked payments on the session and paidVia/paymentIds in the history, filtered by from/to', async () => {
    const h = new ParkingHarness({ provider: 'emulator', scenario: 'payable' });
    await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    const hero = await h.sessions.getHero(USER_ID);
    const sessionId = hero.session!.id;
    const failed = await h.payments.pay(USER_ID, sessionId);
    h.paymentsPort.setStatus(failed.payment.id, 'failed');
    const paid = await h.payments.pay(USER_ID, sessionId);
    await h.payments.applyPaymentSucceeded(h.paymentsPort.succeed(paid.payment.id));
    h.setTime('15:52');
    await h.sessions.markLeft(USER_ID, sessionId);

    // An earlier info-mode stay paid at the paymat, and a free one.
    await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, true);
    h.setTime('11:00', '2026-01-10');
    const timer = await h.info.start(USER_ID, {
      zone: 'surface',
      enteredAt: at('09:00', '2026-01-10'),
    });
    await h.info.paidAtPaymat(USER_ID, timer.id, {});
    await h.info.exit(USER_ID, timer.id);
    h.setTime('12:20', '2026-01-12');
    const free = await h.info.start(USER_ID, {
      zone: 'surface',
      enteredAt: at('12:00', '2026-01-12'),
    });
    await h.info.exit(USER_ID, free.id);

    h.setTime('16:00');
    const view = await h.sessions.view(await h.sessions.getOwned(USER_ID, sessionId));
    expect(view.payments.map((payment) => [payment.id, payment.status])).toEqual([
      [failed.payment.id, 'failed'],
      [paid.payment.id, 'succeeded'],
    ]);
    expect(view.payments[1]).toMatchObject({ amountKopecks: 6000, paidUntil: at('16:00') });

    const page = await h.sessions.history(USER_ID, { limit: 10 });
    expect(page.items.map((item) => [item.id, item.paidVia, item.paymentIds])).toEqual([
      [sessionId, 'app', [paid.payment.id]],
      [free.id, 'free', []],
      [timer.id, 'paymat', []],
    ]);

    const january12 = await h.sessions.history(USER_ID, {
      limit: 10,
      from: at('00:00', '2026-01-11'),
      to: at('00:00', '2026-01-13'),
    });
    expect(january12.items.map((item) => item.id)).toEqual([free.id]);
  });

  it('summarises a Kyiv month: visits, paid amount, time parked (disputed excluded)', async () => {
    const h = await fullMode();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.fakeProvider.set(
      snapshot({
        providerRef: 'op-1',
        enteredAt: at('14:00'),
        paidUntil: at('16:00'),
        amountPaidKopecks: 6000,
      }),
    );
    h.setTime('15:30');
    await h.sessions.getHero(USER_ID);
    h.fakeProvider.set(
      snapshot({
        providerRef: 'op-1',
        enteredAt: at('14:00'),
        paidUntil: at('16:00'),
        amountPaidKopecks: 6000,
        exitedAt: at('15:52'),
      }),
    );
    h.setTime('16:00');
    await h.sync.reconcileMissing([]);
    // A disputed stay in the same month does not count.
    h.fakeProvider.set(
      snapshot({ providerRef: 'op-2', enteredAt: at('16:30'), plate: 'AC1234BC' }),
    );
    h.setTime('16:40');
    const hero = await h.sessions.getHero(USER_ID);
    await h.sessions.dispute(USER_ID, hero.session!.id, { reason: 'not_my_car' });

    await expect(h.sessions.historySummary(USER_ID, '2026-01')).resolves.toEqual({
      month: '2026-01',
      from: new Date('2025-12-31T22:00:00.000Z'),
      to: new Date('2026-01-31T22:00:00.000Z'),
      visits: 1,
      totalPaidKopecks: 6000,
      totalDurationMinutes: 112,
    });
    await expect(h.sessions.historySummary(USER_ID, '2026-02')).resolves.toMatchObject({
      visits: 0,
      totalPaidKopecks: 0,
    });
    await expect(h.sessions.historySummary(USER_ID, '2026-13')).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
    });
  });

  it('F1 offers verify_vehicle only while a vehicle is unverified (finding 14)', async () => {
    const h = await fullMode();
    await h.addVehicle(USER_ID, 'AC1234BC', { verified: true });
    h.setTime('13:00');
    await expect(h.sessions.getHero(USER_ID)).resolves.toMatchObject({
      heroState: 'F1',
      actions: [],
    });
    await h.addVehicle(USER_ID, 'BC0001AA', { verified: false, isDefault: false });
    await expect(h.sessions.getHero(USER_ID)).resolves.toMatchObject({
      heroState: 'F1',
      actions: ['verify_vehicle'],
    });
  });

  it('shows payNow with the next hour near the end of the running hour (finding 5)', async () => {
    const h = await fullMode('emulator');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    await expect(h.sessions.getHero(USER_ID)).resolves.toMatchObject({
      session: { payNow: { amountKopecks: 6000, paidUntil: at('16:00'), includesNextHour: false } },
    });
    h.setTime('15:57');
    await expect(h.sessions.getHero(USER_ID)).resolves.toMatchObject({
      session: {
        amountDueKopecks: 6000,
        payNow: { amountKopecks: 10_000, paidUntil: at('17:00'), includesNextHour: true },
      },
    });
  });
});
