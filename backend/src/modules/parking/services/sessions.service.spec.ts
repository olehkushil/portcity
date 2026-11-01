import { FEATURE_FLAG_KEYS } from '../../../common/contracts/admin';
import { PARKING_EVENTS } from '../../../common/contracts/events';
import { snapshot } from '../testing/fake-parking-provider';
import { OTHER_USER_ID, ParkingHarness, USER_ID } from '../testing/parking-harness';

const at = ParkingHarness.at;

/** Full mode (flag off) with the emulator, as after the operator integration goes live. */
async function fullMode(scenario: 'free' | 'payable' | 'paid' | 'closed'): Promise<ParkingHarness> {
  const h = new ParkingHarness({ provider: 'emulator', scenario });
  await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
  return h;
}

describe('SessionsService.getHero (full mode, prototype timeline)', () => {
  it('F0: no vehicle', async () => {
    const h = await fullMode('payable');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero).toMatchObject({ mode: 'full', heroState: 'F0', session: null });
    expect(hero.actions).toEqual(['add_vehicle']);
  });

  it('F1: vehicle, the car is not inside (before 14:00)', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('13:30');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F1');
    expect(hero.defaultVehicle).toMatchObject({ plate: 'AC1234BC', verified: true });
  });

  it('F2: free at 14:11, found on demand and stored with level and spot', async () => {
    const h = await fullMode('free');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.clock.set(new Date(at('14:11').getTime() + 18_000));
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F2');
    expect(hero.actions).toEqual(['left']);
    expect(hero.session).toMatchObject({
      status: 'open',
      plate: 'AC1234BC',
      plateDisplay: 'AC 1234 BC',
      zone: 'underground',
      level: '-2',
      spot: 'C',
      amountDueKopecks: 0,
      lastSyncedAtLabel: '14:11',
    });
    expect(hero.session?.freeUntil.toISOString()).toBe(at('14:30').toISOString());
    // «Затримаєтесь — 20 ₴ до 15:00»
    expect(hero.session?.nextCharge).toEqual({
      startsAt: at('14:30'),
      endsAt: at('15:00'),
      amountKopecks: 2000,
    });
    expect(h.events()).toEqual([PARKING_EVENTS.sessionOpened]);
  });

  it('F3: 60 UAH due at 15:20, next hour at 16:00 for +40 UAH, with the tariff breakdown', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F3');
    expect(hero.actions).toEqual(['pay', 'left']);
    expect(hero.session).toMatchObject({
      status: 'payable',
      amountDueKopecks: 6000,
      durationMinutes: 80,
    });
    expect(hero.session?.currentHourEndsAt.toISOString()).toBe(at('16:00').toISOString());
    expect(hero.session?.nextCharge).toMatchObject({ startsAt: at('16:00'), amountKopecks: 4000 });
    expect(hero.session?.breakdown.map((line) => [line.kind, line.amountKopecks])).toEqual([
      ['free', 0],
      ['first_hour', 2000],
      ['hour', 4000],
    ]);
  });

  it('F4: paid until 16:00', async () => {
    const h = await fullMode('paid');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:25');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F4');
    expect(hero.session).toMatchObject({
      status: 'paid',
      amountDueKopecks: 0,
      amountPaidKopecks: 6000,
    });
    expect(hero.session?.paidUntil?.toISOString()).toBe(at('16:00').toISOString());
  });

  it('F5: overstay after 16:00, 40 UAH for the new hour', async () => {
    const h = await fullMode('paid');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('16:05');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F5');
    expect(hero.actions).toEqual(['pay', 'left']);
    expect(hero.session).toMatchObject({ status: 'overstay', amountDueKopecks: 4000 });
  });

  it('F6: closed at 15:52 («1 год 52 хв · 60 ₴») for two hours, then F1', async () => {
    const h = await fullMode('closed');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:30');
    await h.sessions.getHero(USER_ID);

    h.setTime('15:55');
    await h.sync.reconcileMissing([]);
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F6');
    expect(hero.session).toMatchObject({
      status: 'closed',
      durationMinutes: 112,
      amountPaidKopecks: 6000,
      stayTotalKopecks: 6000,
    });

    h.setTime('17:53');
    expect((await h.sessions.getHero(USER_ID)).heroState).toBe('F1');
  });

  it('F7: still payable five hours after the entry', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('19:01');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F7');
    // 5 h 01 min: the first hour (20 UAH) plus five started hours of 40 UAH.
    expect(hero.session?.amountDueKopecks).toBe(2000 + 5 * 4000);
  });

  it('refreshes a stale stored session from the operator and degrades when it is down', async () => {
    const h = new ParkingHarness();
    await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:00');
    h.fakeProvider.set(snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }));
    await h.sessions.getHero(USER_ID);

    h.setTime('15:20');
    h.fakeProvider.failWith = new Error('operator down');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.providerAvailable).toBe(false);
    // Still shown, priced at the current time, labelled with the last successful sync.
    expect(hero.session).toMatchObject({ amountDueKopecks: 6000, lastSyncedAtLabel: '15:00' });
  });

  it('backs off from a failing operator for the stale window', async () => {
    const h = new ParkingHarness();
    await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:00');
    h.fakeProvider.failWith = new Error('operator down');
    expect((await h.sessions.getHero(USER_ID)).providerAvailable).toBe(false);

    // Recovered, but within a minute of the failure the operator is not asked again.
    h.fakeProvider.failWith = null;
    h.fakeProvider.set(snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }));
    h.clock.advanceSeconds(30);
    const cached = await h.sessions.getHero(USER_ID);
    expect(cached).toMatchObject({ providerAvailable: false, heroState: 'F1' });

    h.clock.advanceSeconds(31);
    const fresh = await h.sessions.getHero(USER_ID);
    expect(fresh).toMatchObject({ providerAvailable: true, heroState: 'F3' });
  });

  it('shows the air-raid notice and the free exit deadline', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    await h.setFlag(FEATURE_FLAG_KEYS.parkingAirRaid, true, {
      startedAt: at('15:10').toISOString(),
    });
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.notices).toContain('air_raid');
    expect(hero.airRaid).toMatchObject({ active: true, freeExitOpen: true });
    expect(hero.session?.freeExitUntil?.toISOString()).toBe(at('15:40').toISOString());
  });

  it('warns about the underground closing at 21:00 and the night tariff', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('20:40');
    expect((await h.sessions.getHero(USER_ID)).notices).toEqual(['underground_closing_soon']);
    h.setTime('23:40');
    expect((await h.sessions.getHero(USER_ID)).notices).toEqual([
      'underground_closed',
      'night_tariff_soon',
    ]);
  });
});

describe('SessionsService.getHero (unverified plates)', () => {
  it('returns only the amount and the paid period, 10 lookups per hour, then 429', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC', { verified: false });
    h.setTime('15:20');

    const first = await h.sessions.getHero(USER_ID);
    expect(first.session).toBeNull();
    expect(first.restricted).toEqual({
      vehicleId: expect.any(String),
      plate: 'AC1234BC',
      plateDisplay: 'AC 1234 BC',
      amountDueKopecks: 6000,
      paidUntil: null,
    });
    expect(first.heroState).toBe('F3');
    expect(first.actions).toEqual(['verify_vehicle']);
    expect(first.lookupQuota).toMatchObject({ limit: 10, remaining: 9 });

    for (let call = 2; call <= 10; call += 1) {
      await h.sessions.getHero(USER_ID);
    }
    await expect(h.sessions.getHero(USER_ID)).rejects.toMatchObject({
      code: 'PC_PARKING_LOOKUP_LIMIT',
      status: 429,
    });

    // The window resets after an hour.
    h.clock.advanceMinutes(61);
    await expect(h.sessions.getHero(USER_ID)).resolves.toMatchObject({
      lookupQuota: { remaining: 9 },
    });
  });

  it('does not fail the hero when a verified vehicle exists; the restricted part is skipped', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC', { verified: false });
    await h.addVehicle(USER_ID, 'BC0001AA', { verified: true, isDefault: false });
    h.setTime('15:20');
    for (let call = 1; call <= 10; call += 1) {
      await h.sessions.getHero(USER_ID);
    }
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F1');
    expect(hero.restricted).toBeNull();
    expect(hero.lookupQuota).toMatchObject({ remaining: 0 });
  });

  it('does not count lookups while a verified session is shown', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC', { verified: true });
    await h.addVehicle(USER_ID, 'BC0001AA', { verified: false, isDefault: false });
    h.setTime('15:20');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('F3');
    expect(hero.lookupQuota).toBeNull();
    expect((await h.limiter.peek(USER_ID, 10)).remaining).toBe(10);
  });

  it('another member’s verified session is never shown in full to an unverified owner', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(OTHER_USER_ID, 'AC1234BC', { verified: true });
    await h.addVehicle(USER_ID, 'AC1234BC', { verified: false });
    h.setTime('15:20');
    await h.sessions.getHero(OTHER_USER_ID);
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.session).toBeNull();
    expect(hero.restricted).toMatchObject({ amountDueKopecks: 6000, paidUntil: null });
  });
});

describe('SessionsService (info mode and actions)', () => {
  it('I0 without a timer in info mode; I-states follow the timer', async () => {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('13:00');
    const idle = await h.sessions.getHero(USER_ID);
    expect(idle).toMatchObject({ mode: 'info', heroState: 'I0', infoModeEnabled: true });
    expect(idle.actions).toEqual(['start_timer']);
  });

  it('«Я вже виїхав» closes a payable session as closed_unpaid without charging', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    const hero = await h.sessions.getHero(USER_ID);
    const closed = await h.sessions.markLeft(USER_ID, hero.session!.id);
    expect(closed).toMatchObject({
      status: 'closed_unpaid',
      closedReason: 'user_left',
      amountDueKopecks: 6000,
    });
    expect(h.eventPayloads(PARKING_EVENTS.sessionClosed)[0]).toMatchObject({
      closedReason: 'user_left',
    });
    expect(h.paymentsPort.createCalls).toHaveLength(0);

    // The operator still lists the car; the member's statement is not reverted by the sync.
    h.setTime('15:25');
    await h.sync.applySnapshot((await h.provider.findSessionByPlate('AC1234BC'))!);
    expect((await h.sessions.getHero(USER_ID)).heroState).toBe('F6');

    await expect(h.sessions.markLeft(USER_ID, hero.session!.id)).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
    });
  });

  it('«Я вже виїхав» on a free session closes it as closed', async () => {
    const h = await fullMode('free');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('14:10');
    const hero = await h.sessions.getHero(USER_ID);
    await expect(h.sessions.markLeft(USER_ID, hero.session!.id)).resolves.toMatchObject({
      status: 'closed',
    });
  });

  it('hides other members’ sessions', async () => {
    const h = await fullMode('payable');
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:20');
    const hero = await h.sessions.getHero(USER_ID);
    await expect(h.sessions.markLeft(OTHER_USER_ID, hero.session!.id)).rejects.toMatchObject({
      code: 'PC_PARKING_SESSION_NOT_FOUND',
      status: 404,
    });
  });

  it('history pages newest first with durations and amounts', async () => {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');
    for (const [index, day] of ['2026-01-12', '2026-01-13', '2026-01-14'].entries()) {
      h.setTime('15:00', day);
      await h.sync.applySnapshot(
        snapshot({ providerRef: `op-${index}`, enteredAt: at('14:00', day) }),
      );
      h.setTime('15:52', day);
      await h.sync.applySnapshot(
        snapshot({
          providerRef: `op-${index}`,
          enteredAt: at('14:00', day),
          exitedAt: at('15:52', day),
          paidUntil: at('16:00', day),
          amountPaidKopecks: 6000,
        }),
      );
    }
    h.setTime('12:00', '2026-01-15');
    const first = await h.sessions.history(USER_ID, { limit: 2 });
    expect(first.items.map((item) => item.enteredAt.toISOString())).toEqual([
      at('14:00', '2026-01-14').toISOString(),
      at('14:00', '2026-01-13').toISOString(),
    ]);
    expect(first.items[0]).toMatchObject({
      status: 'closed',
      durationMinutes: 112,
      amountPaidKopecks: 6000,
      stayTotalKopecks: 6000,
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await h.sessions.history(USER_ID, { limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect((await h.sessions.history(OTHER_USER_ID, { limit: 10 })).items).toEqual([]);
  });
});
