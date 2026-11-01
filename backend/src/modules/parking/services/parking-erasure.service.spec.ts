import { snapshot } from '../testing/fake-parking-provider';
import { OTHER_USER_ID, ParkingHarness, USER_ID } from '../testing/parking-harness';
import { ERASED_PLATE_PREFIX, erasedPlate } from './parking-erasure.service';

const at = ParkingHarness.at;

describe('erasedPlate', () => {
  it('is a 16-character lower-case placeholder that never looks like a normalised plate', () => {
    const plate = erasedPlate('0192f3a0-0000-7000-8000-00000000abcd');
    expect(plate).toBe(`${ERASED_PLATE_PREFIX}00000abcd`);
    expect(plate).toHaveLength(16);
    expect(plate).not.toMatch(/^[A-Z0-9]+$/);
  });
});

describe('ParkingErasureService.eraseUser (user.deleted)', () => {
  async function seed(h: ParkingHarness) {
    const live = await h.addVehicle(USER_ID, 'AC1234BC');
    const old = await h.addVehicle(USER_ID, 'BC5678AC', { isDefault: false });
    await h.prisma.vehicle.update({ where: { id: old.id }, data: { deletedAt: at('10:00') } });
    const others = await h.addVehicle(OTHER_USER_ID, 'AA0001AA');

    // A closed operator session of the erased member.
    h.fakeProvider.set(
      snapshot({ providerRef: 'op-closed', plate: 'AC1234BC', enteredAt: at('09:00') }),
    );
    h.setTime('09:10');
    await h.sync.applySnapshot((await h.provider.getSessionByRef('op-closed'))!);
    h.fakeProvider.set(
      snapshot({
        providerRef: 'op-closed',
        plate: 'AC1234BC',
        enteredAt: at('09:00'),
        exitedAt: at('09:20'),
      }),
    );
    h.setTime('09:25');
    await h.sync.applySnapshot((await h.provider.getSessionByRef('op-closed'))!);

    // An active operator session (car inside) and the other member's session.
    h.setTime('14:00');
    h.fakeProvider.set(
      snapshot({
        providerRef: 'op-active',
        plate: 'AC1234BC',
        enteredAt: at('13:50'),
        level: '-2',
        spot: 'C',
      }),
    );
    await h.sync.applySnapshot((await h.provider.getSessionByRef('op-active'))!);
    h.fakeProvider.set(
      snapshot({ providerRef: 'op-other', plate: 'AA0001AA', enteredAt: at('13:40') }),
    );
    await h.sync.applySnapshot((await h.provider.getSessionByRef('op-other'))!);

    // An info-mode timer of the erased member.
    await h.sync.createInfoTimer({
      userId: USER_ID,
      vehicleId: live.id,
      plate: 'AC1234BC',
      zone: 'surface',
      enteredAt: at('13:55'),
    });
    return { live, old, others };
  }

  function sessionByRef(h: ParkingHarness, ref: string | null, source = 'provider') {
    return h.sessionsRows().find((row) => row['providerRef'] === ref && row['source'] === source);
  }

  it('soft-deletes and masks vehicles, scrubs closed sessions and detaches active ones', async () => {
    const h = new ParkingHarness();
    const { live, old, others } = await seed(h);
    h.setTime('14:05');

    const summary = await h.erasure.eraseUser(USER_ID);
    expect(summary).toEqual({
      userId: USER_ID,
      vehiclesErased: 2,
      closedSessionsScrubbed: 1,
      activeSessionsUnlinked: 2,
    });

    const liveRow = await h.prisma.vehicle.findUnique({ where: { id: live.id } });
    expect(liveRow).toMatchObject({
      plate: erasedPlate(live.id),
      plateDisplay: erasedPlate(live.id),
      isDefault: false,
      deletedAt: at('14:05'),
    });
    const oldRow = await h.prisma.vehicle.findUnique({ where: { id: old.id } });
    expect(oldRow).toMatchObject({ plate: erasedPlate(old.id), deletedAt: at('10:00') });
    const othersRow = await h.prisma.vehicle.findUnique({ where: { id: others.id } });
    expect(othersRow).toMatchObject({ plate: 'AA0001AA', deletedAt: null });

    expect(sessionByRef(h, 'op-closed')).toMatchObject({
      userId: USER_ID,
      plate: null,
      vehicleId: null,
      status: 'closed',
    });
    expect(sessionByRef(h, 'op-active')).toMatchObject({
      userId: null,
      vehicleId: null,
      plate: 'AC1234BC',
      level: '-2',
      spot: 'C',
      lastSyncedAt: at('14:05'),
    });
    expect(sessionByRef(h, null, 'info_timer')).toMatchObject({
      userId: null,
      vehicleId: null,
      plate: null,
    });
    expect(sessionByRef(h, 'op-other')).toMatchObject({
      userId: OTHER_USER_ID,
      plate: 'AA0001AA',
    });
  });

  it('is idempotent and the operator cannot re-link the erased account', async () => {
    const h = new ParkingHarness();
    await seed(h);
    h.setTime('14:05');
    await h.erasure.eraseUser(USER_ID);
    const eventsBefore = h.events().length;

    expect(await h.erasure.eraseUser(USER_ID)).toEqual({
      userId: USER_ID,
      vehiclesErased: 0,
      closedSessionsScrubbed: 0,
      activeSessionsUnlinked: 0,
    });

    h.setTime('14:10');
    await h.sync.applySnapshot((await h.provider.getSessionByRef('op-active'))!);
    expect(sessionByRef(h, 'op-active')).toMatchObject({ userId: null, vehicleId: null });
    expect(h.events()).toHaveLength(eventsBefore);
  });
});
