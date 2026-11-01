import { snapshot } from '../testing/fake-parking-provider';
import { OTHER_USER_ID, ParkingHarness, USER_ID } from '../testing/parking-harness';

const at = ParkingHarness.at;
const ADMIN_ID = '0192f3a0-0000-7000-8000-0000000000ad';

describe('ParkingService (PARKING_PORT and back office)', () => {
  async function withSession(): Promise<{ h: ParkingHarness; sessionId: string }> {
    const h = new ParkingHarness();
    await h.addVehicle(USER_ID, 'AC1234BC');
    h.setTime('15:00');
    const result = await h.sync.applySnapshot(
      snapshot({ providerRef: 'op-1', enteredAt: at('14:00') }),
    );
    return { h, sessionId: result.record!.id };
  }

  it('getSessionForUser returns the active session priced at the current time', async () => {
    const { h, sessionId } = await withSession();
    h.setTime('15:20');
    await expect(h.parking.getSessionForUser(USER_ID)).resolves.toMatchObject({
      id: sessionId,
      status: 'payable',
      amountDueKopecks: 6000,
      source: 'provider',
      plate: 'AC1234BC',
    });
    await expect(h.parking.getSessionForUser(OTHER_USER_ID)).resolves.toBeNull();
    await expect(h.parking.getSession(sessionId)).resolves.toMatchObject({ id: sessionId });
    await expect(h.parking.getSession('0192f3a0-0000-7000-8000-00000000dead')).resolves.toBeNull();
  });

  it('prefers the operator session over an info timer', async () => {
    const { h, sessionId } = await withSession();
    await h.info.start(USER_ID, { zone: 'surface', enteredAt: at('14:30') });
    await expect(h.parking.getSessionForUser(USER_ID)).resolves.toMatchObject({ id: sessionId });
  });

  it('quote and getActiveTariff use the default tariff while the table is empty', async () => {
    const h = new ParkingHarness();
    await expect(h.parking.getActiveTariff()).resolves.toMatchObject({
      version: 0,
      config: { freeMinutes: 30, firstHourKopecks: 2000, nextHourKopecks: 4000 },
    });
    const quote = await h.parking.quote({ enteredAt: at('14:00'), now: at('15:20') });
    expect(quote.amountDueKopecks).toBe(6000);
    expect(quote.currentHourEndsAt.toISOString()).toBe(at('16:00').toISOString());
  });

  it('daily stats count opened and closed sessions and the paid amount', async () => {
    const { h } = await withSession();
    h.setTime('15:52');
    await h.sync.applySnapshot(
      snapshot({
        providerRef: 'op-1',
        enteredAt: at('14:00'),
        exitedAt: at('15:52'),
        paidUntil: at('16:00'),
        amountPaidKopecks: 6000,
      }),
    );
    const stats = await h.parking.getDailyStats({
      from: at('00:00'),
      to: at('00:00', '2026-01-16'),
    });
    expect(stats).toEqual({ opened: 1, closed: 1, paidKopecks: 6000 });
  });

  it('closeFree closes as closed_free with an audit row; admin list filters by plate', async () => {
    const { h, sessionId } = await withSession();
    h.setTime('15:20');
    const closed = await h.parking.closeFree(
      sessionId,
      { reason: 'privilege', note: 'disabled driver' },
      { id: ADMIN_ID, ip: '127.0.0.1' },
    );
    expect(closed).toMatchObject({ status: 'closed_free', closedReason: 'privilege' });
    expect(h.prisma.auditLog.rows[0]).toMatchObject({
      action: 'parking_session.close_free',
      entityId: sessionId,
      actorId: ADMIN_ID,
      reason: 'disabled driver',
    });
    await expect(
      h.parking.closeFree(sessionId, { reason: 'air_raid' }, { id: ADMIN_ID }),
    ).rejects.toMatchObject({ code: 'PC_PARKING_INVALID_TRANSITION' });

    const page = await h.parking.listForAdmin({ plate: 'AC1234BC', limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([sessionId]);
    expect((await h.parking.listForAdmin({ plate: 'BC0001AA', limit: 10 })).items).toEqual([]);
  });
});
