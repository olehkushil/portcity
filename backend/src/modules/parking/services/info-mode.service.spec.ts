import { FEATURE_FLAG_KEYS } from '../../../common/contracts/admin';
import { OTHER_USER_ID, ParkingHarness, USER_ID } from '../testing/parking-harness';

const at = ParkingHarness.at;

describe('InfoModeService edit and discard (finding 11)', () => {
  it('corrects the entry time and the zone of a running timer', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('15:00') });
    expect(timer).toMatchObject({ status: 'open', amountDueKopecks: 0 });

    const moved = await h.info.update(USER_ID, timer.id, { enteredAt: at('14:00') });
    expect(moved).toMatchObject({ status: 'payable', amountDueKopecks: 6000, zone: 'surface' });
    const zoned = await h.info.update(USER_ID, timer.id, { zone: 'underground' });
    expect(zoned).toMatchObject({ zone: 'underground', enteredAt: at('14:00') });

    await expect(h.info.update(USER_ID, timer.id, {})).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
    });
    await expect(
      h.info.update(USER_ID, timer.id, { enteredAt: at('16:00') }),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await expect(h.info.update(OTHER_USER_ID, timer.id, { zone: 'surface' })).rejects.toMatchObject(
      { code: 'PC_PARKING_SESSION_NOT_FOUND' },
    );

    await h.info.paidAtPaymat(USER_ID, timer.id, { paidUntil: at('15:00') });
    // The entry must stay before the paid-until time from the paymat receipt.
    await expect(
      h.info.update(USER_ID, timer.id, { enteredAt: at('15:10') }),
    ).rejects.toMatchObject({
      code: 'PC_COMMON_VALIDATION',
      details: [{ path: 'enteredAt', messages: ['enteredAt must be before the paid-until time'] }],
    });

    await h.info.exit(USER_ID, timer.id);
    await expect(h.info.update(USER_ID, timer.id, { zone: 'surface' })).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
    });
  });

  it('discards a timer without leaving history, running or finished', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('15:00') });
    await expect(h.info.discard(OTHER_USER_ID, timer.id)).rejects.toMatchObject({
      code: 'PC_PARKING_SESSION_NOT_FOUND',
    });
    await h.info.discard(USER_ID, timer.id);
    expect(h.sessionsRows()).toHaveLength(0);
    await expect(h.sessions.history(USER_ID, { limit: 10 })).resolves.toMatchObject({ items: [] });
    await expect(h.info.discard(USER_ID, timer.id)).rejects.toMatchObject({
      code: 'PC_PARKING_SESSION_NOT_FOUND',
    });

    const finished = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('15:10') });
    await h.info.exit(USER_ID, finished.id);
    await h.info.discard(USER_ID, finished.id);
    expect(h.sessionsRows()).toHaveLength(0);
  });
});

describe('InfoModeService (design brief 4.2, I0-I4)', () => {
  it('runs the prototype timeline: start 14:00, I1 free, I2 at 15:20, I3 paid at the paymat until 16:00, I4 at 15:52', async () => {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');

    h.setTime('14:00');
    const started = await h.info.start(USER_ID, { zone: 'underground', enteredAt: at('14:00') });
    expect(started).toMatchObject({
      source: 'info_timer',
      status: 'open',
      plate: 'AC1234BC',
      zone: 'underground',
      lastSyncedAtLabel: null,
    });
    h.clock.set(new Date(at('14:11').getTime() + 18_000));
    expect((await h.sessions.getHero(USER_ID)).heroState).toBe('I1');

    h.setTime('15:20');
    const payable = await h.sessions.getHero(USER_ID);
    expect(payable.heroState).toBe('I2');
    expect(payable.actions).toEqual(['paid_at_paymat', 'exit_timer']);
    expect(payable.session).toMatchObject({ amountDueKopecks: 6000, stayTotalKopecks: 6000 });

    const paid = await h.info.paidAtPaymat(USER_ID, started.id, {});
    expect(paid).toMatchObject({ status: 'paid', amountDueKopecks: 0, amountPaidKopecks: 0 });
    expect(paid.paidUntil?.toISOString()).toBe(at('16:00').toISOString());
    expect((await h.sessions.getHero(USER_ID)).heroState).toBe('I3');

    h.setTime('15:52');
    const left = await h.info.exit(USER_ID, started.id);
    expect(left).toMatchObject({
      status: 'closed',
      closedReason: 'user_exit',
      durationMinutes: 112,
      stayTotalKopecks: 6000,
    });
    expect((await h.sessions.getHero(USER_ID)).heroState).toBe('I4');
    h.setTime('17:53');
    expect((await h.sessions.getHero(USER_ID)).heroState).toBe('I0');
    // Info timers publish nothing by default (reminders are local on the device).
    expect(h.events()).toEqual([]);
  });

  it('I3 turns into an overstay when the paymat period runs out', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('14:00') });
    await h.info.paidAtPaymat(USER_ID, timer.id, { paidUntil: at('16:00') });
    h.setTime('16:10');
    const hero = await h.sessions.getHero(USER_ID);
    expect(hero.heroState).toBe('I3');
    expect(hero.session).toMatchObject({ status: 'overstay', amountDueKopecks: 4000 });
  });

  it('an exit without paying closes as closed_unpaid (paid at the paymat, unknown to us)', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('14:00') });
    await expect(h.info.exit(USER_ID, timer.id)).resolves.toMatchObject({
      status: 'closed_unpaid',
      amountDueKopecks: 6000,
    });
  });

  it('an exit inside the air-raid window is free', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('14:00') });
    await h.setFlag(FEATURE_FLAG_KEYS.parkingAirRaid, true, {
      startedAt: at('15:15').toISOString(),
    });
    await expect(h.info.exit(USER_ID, timer.id)).resolves.toMatchObject({
      status: 'closed_free',
      closedReason: 'air_raid',
    });
  });

  it('validates the entry time and allows one running timer', async () => {
    const h = new ParkingHarness();
    h.setTime('15:00');
    await expect(
      h.info.start(USER_ID, { zone: 'surface', enteredAt: at('15:10') }),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION', status: 400 });
    await expect(
      h.info.start(USER_ID, { zone: 'surface', enteredAt: at('14:00', '2026-01-13') }),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });

    // A minute of clock skew is accepted and clamped to now.
    const timer = await h.info.start(USER_ID, {
      zone: 'surface',
      enteredAt: new Date(at('15:00').getTime() + 60_000),
    });
    expect(timer.enteredAt.toISOString()).toBe(at('15:00').toISOString());

    await expect(
      h.info.start(USER_ID, { zone: 'underground', enteredAt: at('15:00') }),
    ).rejects.toMatchObject({ code: 'PC_PARKING_SESSION_ACTIVE_EXISTS', status: 409 });
  });

  it('validates paidUntil and hides other members’ timers', async () => {
    const h = new ParkingHarness();
    h.setTime('15:20');
    const timer = await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('14:00') });
    await expect(
      h.info.paidAtPaymat(USER_ID, timer.id, { paidUntil: at('13:00') }),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await expect(
      h.info.paidAtPaymat(USER_ID, timer.id, { paidUntil: at('18:00', '2026-01-16') }),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
    await expect(h.info.exit(OTHER_USER_ID, timer.id)).rejects.toMatchObject({
      code: 'PC_PARKING_SESSION_NOT_FOUND',
      status: 404,
    });
    await h.info.exit(USER_ID, timer.id);
    await expect(h.info.exit(USER_ID, timer.id)).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
      status: 409,
    });
  });

  it('is switched off by the feature flag', async () => {
    const h = new ParkingHarness();
    await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
    await expect(
      h.info.start(USER_ID, { zone: 'surface', enteredAt: h.clock.now() }),
    ).rejects.toMatchObject({ code: 'PC_PARKING_INFO_MODE_DISABLED', status: 403 });
  });
});
