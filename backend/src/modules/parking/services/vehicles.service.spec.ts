import { PARKING_EVENTS } from '../../../common/contracts/events';
import { snapshot } from '../testing/fake-parking-provider';
import { OTHER_USER_ID, ParkingHarness, USER_ID } from '../testing/parking-harness';

describe('VehiclesService label, makeDefault and verification cap (finding 14)', () => {
  it('stores the label and makes a later vehicle the default on request', async () => {
    const h = new ParkingHarness();
    const first = await h.vehicles.add(USER_ID, 'AC1234BC', { label: '  Моя Škoda  ' });
    expect(first).toMatchObject({ label: 'Моя Škoda', isDefault: true });
    const second = await h.vehicles.add(USER_ID, 'BC0001AA', { makeDefault: true });
    expect(second).toMatchObject({ label: null, isDefault: true });
    const list = await h.vehicles.list(USER_ID);
    expect(list.map((vehicle) => [vehicle.plate, vehicle.isDefault])).toEqual([
      ['BC0001AA', true],
      ['AC1234BC', false],
    ]);
  });

  it('allows 5 verification attempts per vehicle in 24 h, also across delete and re-add', async () => {
    const h = new ParkingHarness();
    h.fakeProvider.verification = 'invalid_code';
    const vehicle = await h.vehicles.add(USER_ID, 'AC1234BC');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        h.vehicles.verify(USER_ID, vehicle.id, { talonCode: '0000' }),
      ).rejects.toMatchObject({ code: 'PC_PARKING_VERIFICATION_FAILED' });
    }
    await expect(
      h.vehicles.verify(USER_ID, vehicle.id, { talonCode: '771234' }),
    ).rejects.toMatchObject({ code: 'PC_PARKING_VERIFICATION_LIMIT', status: 429 });
    expect(h.fakeProvider.verificationCalls).toHaveLength(5);

    await h.vehicles.remove(USER_ID, vehicle.id);
    const again = await h.vehicles.add(USER_ID, 'AC1234BC');
    await expect(
      h.vehicles.verify(USER_ID, again.id, { talonCode: '771234' }),
    ).rejects.toMatchObject({ code: 'PC_PARKING_VERIFICATION_LIMIT' });

    // Another member's car has its own quota; the window ends after 24 h.
    const other = await h.vehicles.add(OTHER_USER_ID, 'BC0001AA');
    h.fakeProvider.verification = 'verified';
    await expect(
      h.vehicles.verify(OTHER_USER_ID, other.id, { talonCode: '0001' }),
    ).resolves.toMatchObject({
      verified: true,
    });
    h.clock.advanceMinutes(24 * 60 + 1);
    await expect(
      h.vehicles.verify(USER_ID, again.id, { talonCode: '771234' }),
    ).resolves.toMatchObject({
      verified: true,
    });
  });
});

describe('VehiclesService', () => {
  it('adds a plate typed in Cyrillic as normalised Latin; the first vehicle is the default', async () => {
    const h = new ParkingHarness();
    const first = await h.vehicles.add(USER_ID, ' ас 1234-вс ');
    expect(first).toMatchObject({
      plate: 'AC1234BC',
      plateDisplay: 'AC 1234 BC',
      verified: false,
      verifiedVia: 'none',
      isDefault: true,
    });
    const second = await h.vehicles.add(USER_ID, 'BC0001AA');
    expect(second.isDefault).toBe(false);
    expect((await h.vehicles.list(USER_ID)).map((v) => v.plate)).toEqual(['AC1234BC', 'BC0001AA']);
  });

  it.each([
    ['garbage', '!!!'],
    ['letters only', 'ABCDEF'],
    ['digits only', '123456'],
    ['too long', 'AC1234BC1234567'],
  ])('rejects an invalid plate (%s)', async (_case, plate) => {
    const h = new ParkingHarness();
    await expect(h.vehicles.add(USER_ID, plate)).rejects.toMatchObject({
      code: 'PC_PARKING_PLATE_INVALID',
      status: 400,
    });
  });

  it('rejects a duplicate plate and enforces the vehicle limit', async () => {
    const h = new ParkingHarness({ config: { PARKING_MAX_VEHICLES: 2 } });
    await h.vehicles.add(USER_ID, 'AC1234BC');
    await expect(h.vehicles.add(USER_ID, 'АС1234ВС')).rejects.toMatchObject({
      code: 'PC_PARKING_VEHICLE_EXISTS',
      status: 409,
    });
    await h.vehicles.add(USER_ID, 'BC0001AA');
    await expect(h.vehicles.add(USER_ID, 'KA7777KA')).rejects.toMatchObject({
      code: 'PC_PARKING_VEHICLE_LIMIT',
      status: 422,
    });
    // Another member may add the same plate (unverified).
    await expect(h.vehicles.add(OTHER_USER_ID, 'AC1234BC')).resolves.toMatchObject({
      plate: 'AC1234BC',
    });
  });

  it('removes a vehicle softly and promotes the next one to default', async () => {
    const h = new ParkingHarness();
    const first = await h.vehicles.add(USER_ID, 'AC1234BC');
    const second = await h.vehicles.add(USER_ID, 'BC0001AA');
    await h.vehicles.remove(USER_ID, first.id);
    const list = await h.vehicles.list(USER_ID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: second.id, isDefault: true });
    expect(
      h.prisma.vehicle.rows.find((row) => row['id'] === first.id)?.['deletedAt'],
    ).toBeInstanceOf(Date);
    // The plate can be added again after the soft delete.
    await expect(h.vehicles.add(USER_ID, 'AC1234BC')).resolves.toMatchObject({ isDefault: false });
  });

  it('does not remove a vehicle with an active session and hides other members’ vehicles', async () => {
    const h = new ParkingHarness();
    const vehicle = await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:00');
    await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-1', enteredAt: ParkingHarness.at('14:00') }),
    );
    await expect(h.vehicles.remove(USER_ID, vehicle.id)).rejects.toMatchObject({
      code: 'PC_PARKING_INVALID_TRANSITION',
      status: 409,
    });
    await expect(h.vehicles.remove(OTHER_USER_ID, vehicle.id)).rejects.toMatchObject({
      code: 'PC_PARKING_VEHICLE_NOT_FOUND',
      status: 404,
    });
  });

  it('sets the default vehicle', async () => {
    const h = new ParkingHarness();
    const first = await h.vehicles.add(USER_ID, 'AC1234BC');
    const second = await h.vehicles.add(USER_ID, 'BC0001AA');
    await h.vehicles.setDefault(USER_ID, second.id);
    const list = await h.vehicles.list(USER_ID);
    expect(list[0]).toMatchObject({ id: second.id, isDefault: true });
    expect(list[1]).toMatchObject({ id: first.id, isDefault: false });
  });

  describe('verify', () => {
    it('verifies by talon code, publishes the event and attaches the stored anonymous session', async () => {
      const h = new ParkingHarness({ provider: 'emulator' });
      const vehicle = await h.vehicles.add(USER_ID, 'AC1234BC');
      h.setTime('15:20');
      await h.sync.applySnapshot((await h.provider.findSessionByPlate('AC1234BC'))!);
      expect(h.sessionsRows()[0]).toMatchObject({ userId: null });

      const verified = await h.vehicles.verify(USER_ID, vehicle.id, { talonCode: '0412-771234' });
      expect(verified).toMatchObject({ verified: true, verifiedVia: 'talon' });
      expect(verified.verifiedAt?.toISOString()).toBe(ParkingHarness.at('15:20').toISOString());
      expect(h.eventPayloads(PARKING_EVENTS.vehicleVerified)[0]).toMatchObject({
        vehicleId: vehicle.id,
        userId: USER_ID,
        plate: 'AC1234BC',
        verifiedVia: 'talon',
      });
      expect(h.sessionsRows()[0]).toMatchObject({ userId: USER_ID, vehicleId: vehicle.id });

      // Idempotent: a verified vehicle stays verified without another operator call.
      await expect(
        h.vehicles.verify(USER_ID, vehicle.id, { paymatCode: '1234' }),
      ).resolves.toMatchObject({ verified: true, verifiedVia: 'talon' });
    });

    it('verifies by paymat code', async () => {
      const h = new ParkingHarness({ provider: 'emulator' });
      const vehicle = await h.vehicles.add(USER_ID, 'AC1234BC');
      await expect(
        h.vehicles.verify(USER_ID, vehicle.id, { paymatCode: '1234' }),
      ).resolves.toMatchObject({ verifiedVia: 'paymat_code' });
    });

    it.each([
      [{}, 'one_code_required'],
      [{ talonCode: '1234', paymatCode: '1234' }, 'one_code_required'],
      [{ talonCode: '12 34!' }, 'code_format'],
    ])('rejects malformed input %p', async (input, reason) => {
      const h = new ParkingHarness({ provider: 'emulator' });
      const vehicle = await h.vehicles.add(USER_ID, 'AC1234BC');
      await expect(h.vehicles.verify(USER_ID, vehicle.id, input)).rejects.toMatchObject({
        code: 'PC_PARKING_VERIFICATION_FAILED',
        status: 400,
        details: { reason },
      });
    });

    it('rejects a code that does not match the plate', async () => {
      const h = new ParkingHarness({ provider: 'emulator' });
      const vehicle = await h.vehicles.add(USER_ID, 'AC1234BC');
      await expect(
        h.vehicles.verify(USER_ID, vehicle.id, { talonCode: '9999' }),
      ).rejects.toMatchObject({ code: 'PC_PARKING_VERIFICATION_FAILED', status: 422 });
    });

    it('maps the operator answers and failures', async () => {
      const h = new ParkingHarness();
      const vehicle = await h.vehicles.add(USER_ID, 'AC1234BC');
      h.fakeProvider.verification = 'unknown_plate';
      await expect(
        h.vehicles.verify(USER_ID, vehicle.id, { talonCode: '1234' }),
      ).rejects.toMatchObject({ code: 'PC_PARKING_UNKNOWN_PLATE', status: 422 });

      h.fakeProvider.failWith = new Error('timeout');
      await expect(
        h.vehicles.verify(USER_ID, vehicle.id, { talonCode: '1234' }),
      ).rejects.toMatchObject({ code: 'PC_PARKING_PROVIDER_UNAVAILABLE', status: 503 });
    });

    it('refuses a plate already verified in another account (contact support)', async () => {
      const h = new ParkingHarness();
      await h.addVehicle(OTHER_USER_ID, 'AC1234BC', { verified: true });
      const vehicle = await h.vehicles.add(USER_ID, 'AC1234BC');
      await expect(
        h.vehicles.verify(USER_ID, vehicle.id, { talonCode: '1234' }),
      ).rejects.toMatchObject({
        code: 'PC_PARKING_VERIFICATION_FAILED',
        status: 409,
        details: { reason: 'verified_in_other_account' },
      });
      expect(h.fakeProvider.verificationCalls).toHaveLength(0);
    });
  });
});
