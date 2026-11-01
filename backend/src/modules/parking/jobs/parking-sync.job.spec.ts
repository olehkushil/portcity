import { FEATURE_FLAG_KEYS } from '../../../common/contracts/admin';
import { PARKING_EVENTS } from '../../../common/contracts/events';
import type { ProviderSessionSnapshot } from '../provider/parking-provider.port';
import { VendorParkingProvider } from '../provider/vendor.provider';
import { snapshot } from '../testing/fake-parking-provider';
import { ParkingHarness, USER_ID } from '../testing/parking-harness';
import { type ParkingSyncDeps, runParkingSync } from './parking-sync.job';

const at = ParkingHarness.at;

function deps(overrides: Partial<ParkingSyncDeps> = {}): ParkingSyncDeps {
  return {
    listActiveSnapshots: jest.fn(async () => [] as ProviderSessionSnapshot[]),
    filterTracked: jest.fn(async (items: ProviderSessionSnapshot[]) => items),
    applySnapshot: jest.fn(async () => ({ changed: true, events: ['x'] })),
    reconcileMissing: jest.fn(async () => ({ checked: 0, closed: 0, failed: 0 })),
    tickInfoTimers: jest.fn(async () => ({ checked: 0, changed: 0, closed: 0 })),
    log: jest.fn(),
    ...overrides,
  };
}

describe('runParkingSync (handler with fakes)', () => {
  const a = snapshot({ providerRef: 'a', enteredAt: at('14:00') });
  const b = snapshot({ providerRef: 'b', enteredAt: at('14:00'), plate: 'BC0001AA' });

  it('applies tracked snapshots, reconciles the missing ones and ticks info timers', async () => {
    const d = deps({
      listActiveSnapshots: jest.fn(async () => [a, b]),
      filterTracked: jest.fn(async () => [a]),
      reconcileMissing: jest.fn(async () => ({ checked: 2, closed: 1, failed: 0 })),
      tickInfoTimers: jest.fn(async () => ({ checked: 3, changed: 1, closed: 1 })),
    });
    const summary = await runParkingSync(d);
    expect(d.applySnapshot).toHaveBeenCalledTimes(1);
    expect(d.reconcileMissing).toHaveBeenCalledWith(['a', 'b']);
    expect(summary).toEqual({
      providerAvailable: true,
      seen: 2,
      tracked: 1,
      changed: 1,
      events: 1,
      failed: 0,
      missingChecked: 2,
      missingClosed: 1,
      infoTimersChecked: 3,
      infoTimersChanged: 1,
      infoTimersClosed: 1,
    });
  });

  it('keeps going when one session fails', async () => {
    const d = deps({
      listActiveSnapshots: jest.fn(async () => [a, b]),
      applySnapshot: jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ changed: false, events: [] }),
    });
    const summary = await runParkingSync(d);
    expect(summary).toMatchObject({ failed: 1, changed: 0, tracked: 2 });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('session a failed: boom'));
  });

  it('skips operator steps when the operator is down but still ticks info timers', async () => {
    const d = deps({
      listActiveSnapshots: jest.fn(async () => {
        throw new Error('503');
      }),
      tickInfoTimers: jest.fn(async () => ({ checked: 1, changed: 1, closed: 0 })),
    });
    const summary = await runParkingSync(d);
    expect(summary).toMatchObject({ providerAvailable: false, seen: 0, infoTimersChanged: 1 });
    expect(d.applySnapshot).not.toHaveBeenCalled();
    expect(d.reconcileMissing).not.toHaveBeenCalled();
  });

  it('counts a failing reconciliation or timer tick without throwing', async () => {
    const d = deps({
      reconcileMissing: jest.fn(async () => {
        throw new Error('db');
      }),
      tickInfoTimers: jest.fn(async () => {
        throw new Error('db');
      }),
    });
    await expect(runParkingSync(d)).resolves.toMatchObject({ failed: 2 });
  });
});

describe('runParkingSync with the real services and the emulator', () => {
  function wire(h: ParkingHarness): ParkingSyncDeps {
    return {
      listActiveSnapshots: () => h.sync.listActiveSnapshots(),
      filterTracked: (items) => h.sync.filterTracked(items),
      applySnapshot: (item) => h.sync.applySnapshot(item),
      reconcileMissing: (refs) => h.sync.reconcileMissing(refs),
      tickInfoTimers: () => h.sync.tickInfoTimers(),
    };
  }

  it('every 60 s walks the closed scenario through open, payable, paid, closed', async () => {
    const h = new ParkingHarness({ provider: 'emulator', scenario: 'closed' });
    await h.setFlag(FEATURE_FLAG_KEYS.parkingInfoMode, false);
    await h.addVehicle(USER_ID, 'AC1234BC');

    const statuses: string[] = [];
    h.setTime('13:59');
    for (let minute = 0; minute <= 120; minute += 1) {
      await runParkingSync(wire(h));
      const row = h.sessionsRows()[0];
      const status = row ? String(row['status']) : 'none';
      if (statuses[statuses.length - 1] !== status) {
        statuses.push(status);
      }
      h.clock.advanceMinutes(1);
    }
    expect(statuses).toEqual(['none', 'open', 'payable', 'paid', 'closed']);
    // 14:25 free ends in 5 min, 14:31 payable, 15:20 paid until 16:00, 15:50 exit in 10 min,
    // 15:52 exit.
    expect(h.events()).toEqual([
      PARKING_EVENTS.sessionOpened,
      PARKING_EVENTS.sessionFreeEnding,
      PARKING_EVENTS.sessionPayable,
      PARKING_EVENTS.sessionPaid,
      PARKING_EVENTS.sessionExitSoon,
      PARKING_EVENTS.sessionClosed,
    ]);
  });

  it('reports the vendor stub as unavailable without failing', async () => {
    const h = new ParkingHarness();
    const vendor = new VendorParkingProvider({ baseUrl: null, apiKey: null, webhookSecret: 'x' });
    await expect(
      runParkingSync({ ...wire(h), listActiveSnapshots: () => vendor.listActiveSessions() }),
    ).resolves.toMatchObject({ providerAvailable: false, failed: 0 });
  });
});
