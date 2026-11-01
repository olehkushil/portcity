import { FEATURE_FLAG_KEYS } from '../../../common/contracts/admin';
import { PARKING_EVENTS } from '../../../common/contracts/events';
import type { SessionRecord } from '../domain/session-view';
import { EMULATOR_DEMO_REF, signParkingWebhook } from '../provider/emulator.provider';
import { snapshot } from '../testing/fake-parking-provider';
import { ParkingHarness, TEST_SECRET, USER_ID } from '../testing/parking-harness';

const at = ParkingHarness.at;

async function syncOnce(h: ParkingHarness): Promise<void> {
  const active = await h.sync.listActiveSnapshots();
  const tracked = await h.sync.filterTracked(active);
  for (const item of tracked) {
    await h.sync.applySnapshot(item);
  }
  await h.sync.reconcileMissing(active.map((item) => item.providerRef));
}

async function demoRow(h: ParkingHarness): Promise<SessionRecord> {
  const row = await h.prisma.parkingSession.findUnique({
    where: { providerRef: EMULATOR_DEMO_REF },
  });
  if (!row) {
    throw new Error('demo session not stored');
  }
  return row as unknown as SessionRecord;
}

describe('SessionSyncService with the emulator (prototype timeline)', () => {
  it('scenario payable: open at 14:00, free-ending reminder at 14:25, payable at 14:31, 60 UAH at 15:20', async () => {
    const h = new ParkingHarness({ provider: 'emulator', scenario: 'payable' });
    await h.addVehicle(USER_ID, 'AC1234BC');

    h.setTime('13:59');
    await syncOnce(h);
    expect(h.sessionsRows()).toHaveLength(0);

    h.setTime('14:00');
    await syncOnce(h);
    let row = await demoRow(h);
    expect(row).toMatchObject({
      status: 'open',
      userId: USER_ID,
      plate: 'AC1234BC',
      zone: 'underground',
    });
    expect(h.events()).toEqual([PARKING_EVENTS.sessionOpened]);
    // The operator's level / row is stored on the session row.
    expect(row).toMatchObject({ level: '-2', spot: 'C' });

    h.clock.set(new Date(at('14:24').getTime() + 30_000));
    await syncOnce(h);
    expect(h.events()).toEqual([PARKING_EVENTS.sessionOpened]);

    h.clock.set(new Date(at('14:25').getTime() + 30_000));
    await syncOnce(h);
    expect(h.events()).toEqual([PARKING_EVENTS.sessionOpened, PARKING_EVENTS.sessionFreeEnding]);
    expect(h.eventPayloads(PARKING_EVENTS.sessionFreeEnding)[0]).toMatchObject({
      reminder: 'free_ending',
      deadline: at('14:30').toISOString(),
      minutesLeft: 5,
      userId: USER_ID,
    });

    h.clock.set(new Date(at('14:26').getTime() + 30_000));
    await syncOnce(h);
    expect(h.events()).toHaveLength(2);

    h.setTime('14:31');
    await syncOnce(h);
    row = await demoRow(h);
    expect(row.status).toBe('payable');
    expect(row.amountDueKopecks).toBe(2000);
    const payable = h.eventPayloads(PARKING_EVENTS.sessionPayable);
    expect(payable).toHaveLength(1);
    expect(payable[0]).toMatchObject({
      amountDueKopecks: 2000,
      currentHourEndsAt: at('15:00').toISOString(),
    });

    h.setTime('15:20');
    await syncOnce(h);
    row = await demoRow(h);
    expect(row.status).toBe('payable');
    expect(row.amountDueKopecks).toBe(6000);
    expect(row.lastSyncedAt?.toISOString()).toBe(at('15:20').toISOString());
    expect(h.eventPayloads(PARKING_EVENTS.sessionPayable)).toHaveLength(1);
  });

  it('scenario paid: paid until 16:00 at 15:25, exit reminder at 15:50, overstay after 16:00', async () => {
    const h = new ParkingHarness({ provider: 'emulator', scenario: 'paid' });
    await h.addVehicle(USER_ID, 'AC1234BC');

    h.setTime('15:10');
    await syncOnce(h);
    expect((await demoRow(h)).status).toBe('payable');

    h.setTime('15:25');
    await syncOnce(h);
    let row = await demoRow(h);
    expect(row).toMatchObject({ status: 'paid', amountPaidKopecks: 6000, amountDueKopecks: 0 });
    expect(row.paidUntil?.toISOString()).toBe(at('16:00').toISOString());
    expect(h.eventPayloads(PARKING_EVENTS.sessionPaid)[0]).toMatchObject({
      amountPaidKopecks: 6000,
      paidUntil: at('16:00').toISOString(),
      paymentId: null,
    });

    h.clock.set(new Date(at('15:50').getTime() + 30_000));
    await syncOnce(h);
    expect(h.eventPayloads(PARKING_EVENTS.sessionExitSoon)).toEqual([
      expect.objectContaining({ reminder: 'exit_soon', minutesLeft: 10 }),
    ]);

    h.setTime('16:05');
    await syncOnce(h);
    row = await demoRow(h);
    expect(row).toMatchObject({ status: 'overstay', amountDueKopecks: 4000 });
    expect(h.eventPayloads(PARKING_EVENTS.sessionOverstay)[0]).toMatchObject({
      amountDueKopecks: 4000,
      paidUntil: at('16:00').toISOString(),
    });
  });

  it('scenario closed: the exit at 15:52 is fetched by reference and closes the session (paid, nothing due)', async () => {
    const h = new ParkingHarness({ provider: 'emulator', scenario: 'closed' });
    await h.addVehicle(USER_ID, 'AC1234BC');

    h.setTime('15:30');
    await syncOnce(h);
    expect((await demoRow(h)).status).toBe('paid');

    h.setTime('15:55');
    await syncOnce(h);
    const row = await demoRow(h);
    expect(row).toMatchObject({ status: 'closed', closedReason: 'exit', amountPaidKopecks: 6000 });
    expect(row.exitedAt?.toISOString()).toBe(at('15:52').toISOString());
    expect(h.eventPayloads(PARKING_EVENTS.sessionClosed)[0]).toMatchObject({
      exitedAt: at('15:52').toISOString(),
      closedReason: 'exit',
      status: 'closed',
    });

    // Closed is final: later ticks change nothing and publish nothing.
    const before = h.events().length;
    h.setTime('16:30');
    await syncOnce(h);
    expect(h.events()).toHaveLength(before);
  });

  it('does not store cars of non-members', async () => {
    const h = new ParkingHarness({ provider: 'emulator', scenario: 'payable' });
    h.setTime('15:20');
    await syncOnce(h);
    expect(h.sessionsRows()).toHaveLength(0);
  });

  it('stores sessions of unverified plates without an owner and publishes nothing', async () => {
    const h = new ParkingHarness({ provider: 'emulator', scenario: 'payable' });
    await h.addVehicle(USER_ID, 'AC1234BC', { verified: false });
    h.setTime('15:20');
    await syncOnce(h);
    const row = await demoRow(h);
    expect(row).toMatchObject({ userId: null, vehicleId: null, status: 'payable' });
    expect(h.events()).toEqual([]);
  });
});

describe('SessionSyncService with the fake operator', () => {
  const entered = at('14:00');

  async function setup(): Promise<ParkingHarness> {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');
    return h;
  }

  it('applying the same facts twice is idempotent', async () => {
    const h = await setup();
    h.setTime('15:20');
    const facts = snapshot({ providerRef: 'op-1', enteredAt: entered });
    const first = await h.sync.applySnapshot(facts);
    const second = await h.sync.applySnapshot(facts);
    expect(first.events).toEqual([PARKING_EVENTS.sessionOpened, PARKING_EVENTS.sessionPayable]);
    expect(second.events).toEqual([]);
    expect(second.changed).toBe(false);
    expect(h.sessionsRows()).toHaveLength(1);
  });

  it('keeps the later paid period when the operator lags behind an app payment', async () => {
    const h = await setup();
    h.setTime('15:20');
    await h.sync.applySnapshot(snapshot({ providerRef: 'op-1', enteredAt: entered }));
    const row = (await h.prisma.parkingSession.findFirst({})) as unknown as SessionRecord;
    await h.sync.updateFacts(row, { paidUntil: at('16:00'), amountPaidKopecks: 6000 });

    h.setTime('15:30');
    const result = await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-1', enteredAt: entered, paidUntil: null, amountPaidKopecks: 0 }),
    );
    expect(result.record).toMatchObject({ status: 'paid', amountPaidKopecks: 6000 });
    expect(result.record?.paidUntil?.toISOString()).toBe(at('16:00').toISOString());
  });

  it('air raid: an exit inside the free window closes as closed_free', async () => {
    const h = await setup();
    h.setTime('15:20');
    await h.sync.applySnapshot(snapshot({ providerRef: 'op-1', enteredAt: entered }));
    await h.setFlag(FEATURE_FLAG_KEYS.parkingAirRaid, true, {
      startedAt: at('15:40').toISOString(),
    });

    h.setTime('15:55');
    const result = await h.sync.applySnapshot(
      snapshot({
        providerRef: 'op-1',
        enteredAt: entered,
        exitedAt: at('15:50'),
        closedReason: 'exit',
      }),
    );
    expect(result.record).toMatchObject({
      status: 'closed_free',
      closedReason: 'air_raid',
      amountDueKopecks: 0,
    });
  });

  it('air raid: an exit after the free window is a normal unpaid exit', async () => {
    const h = await setup();
    h.setTime('15:20');
    await h.sync.applySnapshot(snapshot({ providerRef: 'op-1', enteredAt: entered }));
    await h.setFlag(FEATURE_FLAG_KEYS.parkingAirRaid, true, {
      startedAt: at('15:00').toISOString(),
    });

    h.setTime('15:55');
    const result = await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-1', enteredAt: entered, exitedAt: at('15:50') }),
    );
    expect(result.record).toMatchObject({ status: 'closed_unpaid', closedReason: 'exit' });
  });

  it('a member action on a stale copy is re-applied after a concurrent sync tick', async () => {
    const h = await setup();
    h.setTime('15:20');
    await h.sync.applySnapshot(snapshot({ providerRef: 'op-1', enteredAt: entered }));
    const stale = (await h.prisma.parkingSession.findFirst({})) as unknown as SessionRecord;

    h.setTime('15:21');
    await h.sync.applySnapshot(snapshot({ providerRef: 'op-1', enteredAt: entered }));
    const result = await h.sync.updateFacts(stale, {
      exitedAt: at('15:21'),
      closedReason: 'user_left',
    });
    expect(result.record).toMatchObject({ status: 'closed_unpaid', closedReason: 'user_left' });
    expect(h.events().filter((type) => type === PARKING_EVENTS.sessionClosed)).toHaveLength(1);
  });

  it('closes sessions the operator forgot after the TTL', async () => {
    const h = await setup();
    h.setTime('15:20');
    await h.sync.applySnapshot(snapshot({ providerRef: 'op-1', enteredAt: entered }));

    h.setTime('16:00');
    expect(await h.sync.reconcileMissing([])).toEqual({ checked: 1, closed: 0, failed: 0 });

    h.clock.advanceHours(25);
    expect(await h.sync.reconcileMissing([])).toEqual({ checked: 1, closed: 1, failed: 0 });
    const row = (await h.prisma.parkingSession.findFirst({})) as unknown as SessionRecord;
    expect(row).toMatchObject({ status: 'closed_unpaid', closedReason: 'timeout' });
  });

  it('reports operator failures per session without stopping the batch', async () => {
    const h = await setup();
    h.setTime('15:20');
    await h.sync.applySnapshot(snapshot({ providerRef: 'op-1', enteredAt: entered }));
    h.fakeProvider.failWith = new Error('operator down');
    expect(await h.sync.reconcileMissing([])).toEqual({ checked: 1, closed: 0, failed: 1 });
  });

  it('info timers move by time; their events are off by default', async () => {
    const h = await setup();
    h.setTime('14:00');
    const timer = await h.sync.createInfoTimer({
      userId: USER_ID,
      vehicleId: null,
      plate: null,
      zone: 'surface',
      enteredAt: at('14:00'),
    });
    expect(timer.status).toBe('open');
    h.setTime('14:31');
    expect(await h.sync.tickInfoTimers()).toEqual({ checked: 1, changed: 1, closed: 0 });
    const row = (await h.prisma.parkingSession.findFirst({})) as unknown as SessionRecord;
    expect(row).toMatchObject({ status: 'payable', amountDueKopecks: 2000, source: 'info_timer' });
    expect(h.events()).toEqual([]);
  });

  it('info timers publish events when PARKING_INFO_TIMER_EVENTS is on', async () => {
    const h = new ParkingHarness({ config: { PARKING_INFO_TIMER_EVENTS: true } });
    h.setTime('14:00');
    await h.sync.createInfoTimer({
      userId: USER_ID,
      vehicleId: null,
      plate: null,
      zone: 'surface',
      enteredAt: at('14:00'),
    });
    h.setTime('14:31');
    await h.sync.tickInfoTimers();
    // The free-ending moment (14:25) passed between ticks while the timer was still free, but
    // at 14:31 the free period is over, so only the transition is published.
    expect(h.events()).toEqual([PARKING_EVENTS.sessionOpened, PARKING_EVENTS.sessionPayable]);
  });

  it('forgotten info timers are closed after the TTL', async () => {
    const h = await setup();
    h.setTime('14:00');
    await h.sync.createInfoTimer({
      userId: USER_ID,
      vehicleId: null,
      plate: null,
      zone: 'surface',
      enteredAt: at('14:00'),
    });
    h.clock.advanceHours(25);
    expect(await h.sync.tickInfoTimers()).toEqual({ checked: 1, changed: 0, closed: 1 });
  });
});

describe('SessionSyncService: disputed sessions and edited timers', () => {
  it('publishes nothing for a disputed session (no reminders, no transitions)', async () => {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('14:10');
    const created = await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-5', enteredAt: at('14:00') }),
    );
    await h.prisma.parkingSession.updateMany({
      where: { id: created.record!.id },
      data: { disputedAt: at('14:10'), disputeReason: 'not_my_car' },
    });
    const before = h.events().length;
    h.setTime('14:40');
    const result = await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-5', enteredAt: at('14:00') }),
    );
    expect(result.record?.status).toBe('payable');
    expect(h.events()).toHaveLength(before);
  });

  it('moves the entry time and the zone of an info timer through the single write path', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('15:00') });
    expect(timer.status).toBe('open');
    const row = (await h.prisma.parkingSession.findUnique({
      where: { id: timer.id },
    })) as unknown as SessionRecord;
    const result = await h.sync.updateFacts(row, { enteredAt: at('14:00'), zone: 'underground' });
    expect(result.record).toMatchObject({
      enteredAt: at('14:00'),
      zone: 'underground',
      status: 'payable',
      amountDueKopecks: 6000,
    });
  });
});

describe('SessionSyncService.handleWebhook', () => {
  it('applies a signed emulator callback and acknowledges repeats', async () => {
    const h = new ParkingHarness({ provider: 'emulator' });
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    const body = {
      eventId: 'evt-1',
      type: 'session.entered',
      session: {
        providerRef: 'op-77',
        plate: 'AC 1234 BC',
        zone: 'surface',
        enteredAt: at('14:00').toISOString(),
      },
    };
    const headers = { 'x-parking-signature': signParkingWebhook(TEST_SECRET, body) };
    const first = await h.sync.handleWebhook('emulator', { body, headers });
    expect(first).toMatchObject({
      eventId: 'evt-1',
      tracked: true,
      status: 'payable',
      changed: true,
    });
    const second = await h.sync.handleWebhook('emulator', { body, headers });
    expect(second).toMatchObject({ changed: false, duplicate: true, sessionId: first.sessionId });
    expect(h.sessionsRows()).toHaveLength(1);
    expect(h.prisma.parkingWebhookLog.rows).toEqual([
      expect.objectContaining({
        provider: 'emulator',
        eventId: 'evt-1',
        sessionId: first.sessionId,
        processedAt: at('15:20'),
        result: 'changed:payable',
      }),
    ]);
  });

  it('finding 7: a replayed old event id is not applied again after newer facts', async () => {
    const h = new ParkingHarness({ provider: 'emulator' });
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    const sign = (body: object) => ({
      body,
      headers: { 'x-parking-signature': signParkingWebhook(TEST_SECRET, body) },
    });
    const entered = {
      eventId: 'evt-a',
      session: { providerRef: 'op-90', plate: 'AC1234BC', enteredAt: at('14:00').toISOString() },
    };
    const exited = {
      eventId: 'evt-b',
      session: { ...entered.session, exitedAt: at('15:10').toISOString() },
    };
    await h.sync.handleWebhook('emulator', sign(entered));
    await expect(h.sync.handleWebhook('emulator', sign(exited))).resolves.toMatchObject({
      status: 'closed_unpaid',
      duplicate: false,
    });
    await expect(h.sync.handleWebhook('emulator', sign(entered))).resolves.toMatchObject({
      duplicate: true,
      changed: false,
    });
    expect(h.prisma.parkingWebhookLog.rows).toHaveLength(2);
  });

  it('removes the log row when the application fails, so the operator retry is processed', async () => {
    const h = new ParkingHarness({ provider: 'emulator' });
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    const body = {
      eventId: 'evt-fail',
      session: { providerRef: 'op-91', plate: 'AC1234BC', enteredAt: at('14:00').toISOString() },
    };
    const request = {
      body,
      headers: { 'x-parking-signature': signParkingWebhook(TEST_SECRET, body) },
    };
    const apply = jest.spyOn(h.sync, 'applySnapshot').mockRejectedValueOnce(new Error('db down'));
    await expect(h.sync.handleWebhook('emulator', request)).rejects.toThrow('db down');
    expect(h.prisma.parkingWebhookLog.rows).toHaveLength(0);
    apply.mockRestore();
    await expect(h.sync.handleWebhook('emulator', request)).resolves.toMatchObject({
      duplicate: false,
      changed: true,
    });
  });

  it('acknowledges plates of non-members without storing them', async () => {
    const h = new ParkingHarness({ provider: 'emulator' });
    const body = {
      eventId: 'evt-2',
      session: { providerRef: 'op-78', plate: 'BC0001AA', enteredAt: at('14:00').toISOString() },
    };
    const outcome = await h.sync.handleWebhook('emulator', {
      body,
      headers: { 'x-parking-signature': signParkingWebhook(TEST_SECRET, body) },
    });
    expect(outcome).toMatchObject({ tracked: false, sessionId: null });
    expect(h.sessionsRows()).toHaveLength(0);
  });

  it('rejects unknown providers and bad signatures', async () => {
    const h = new ParkingHarness({ provider: 'emulator' });
    await expect(h.sync.handleWebhook('vendor', { body: {}, headers: {} })).rejects.toMatchObject({
      code: 'PC_COMMON_NOT_FOUND',
      status: 404,
    });
    await expect(
      h.sync.handleWebhook('emulator', {
        body: { eventId: 'x' },
        headers: { 'x-parking-signature': 'sha256=bad' },
      }),
    ).rejects.toMatchObject({ code: 'PC_PARKING_WEBHOOK_SIGNATURE', status: 401 });
  });
});
