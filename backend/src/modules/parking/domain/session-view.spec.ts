import { DEFAULT_PARKING_TARIFF } from '../../../common/contracts/parking';
import { type SessionRecord, buildSessionView, mergeLocation } from './session-view';

const t = (hhmm: string): Date => new Date(`2026-01-15T${hhmm}:00.000+02:00`);

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's-1',
    userId: 'u-1',
    vehicleId: 'v-1',
    plate: 'AC1234BC',
    zone: 'underground',
    level: null,
    spot: null,
    enteredAt: t('14:00'),
    exitedAt: null,
    status: 'open',
    paidUntil: null,
    amountDueKopecks: 0,
    amountPaidKopecks: 0,
    providerRef: 'op-1',
    source: 'provider',
    lastSyncedAt: t('14:11'),
    closedReason: null,
    createdAt: t('14:00'),
    updatedAt: t('14:11'),
    ...overrides,
  };
}

describe('buildSessionView', () => {
  const tariff = DEFAULT_PARKING_TARIFF;

  it('re-derives an active session at now (stored status may be a minute old)', () => {
    const view = buildSessionView(record({ status: 'open' }), { now: t('15:20'), tariff });
    expect(view).toMatchObject({
      status: 'payable',
      amountDueKopecks: 6000,
      plateDisplay: 'AC 1234 BC',
      durationMinutes: 80,
      stayTotalKopecks: 6000,
      lastSyncedAtLabel: '14:11',
    });
    expect(view.currentHourEndsAt).toEqual(t('16:00'));
    expect(view.nextCharge).toEqual({
      startsAt: t('16:00'),
      endsAt: t('17:00'),
      amountKopecks: 4000,
    });
  });

  it('F2: the next charge is the first paid half hour', () => {
    const view = buildSessionView(record(), { now: t('14:11'), tariff });
    expect(view.status).toBe('open');
    expect(view.freeUntil).toEqual(t('14:30'));
    expect(view.nextCharge).toEqual({
      startsAt: t('14:30'),
      endsAt: t('15:00'),
      amountKopecks: 2000,
    });
  });

  it('F4: paid until 16:00, nothing due, the next charge starts at 16:00', () => {
    const view = buildSessionView(
      record({ status: 'paid', paidUntil: t('16:00'), amountPaidKopecks: 6000 }),
      { now: t('15:25'), tariff },
    );
    expect(view).toMatchObject({ status: 'paid', amountDueKopecks: 0, amountPaidKopecks: 6000 });
    expect(view.nextCharge?.startsAt).toEqual(t('16:00'));
  });

  it('closed sessions keep their status and are priced at the exit', () => {
    const view = buildSessionView(
      record({
        status: 'closed',
        exitedAt: t('15:52'),
        paidUntil: t('16:00'),
        amountPaidKopecks: 6000,
        closedReason: 'exit',
      }),
      { now: t('18:00'), tariff },
    );
    expect(view).toMatchObject({
      status: 'closed',
      amountDueKopecks: 0,
      durationMinutes: 112,
      stayTotalKopecks: 6000,
      nextCharge: null,
    });
    expect(view.breakdown.map((line) => line.kind)).toEqual(['free', 'first_hour', 'hour']);
  });

  it('closed_unpaid keeps the stored amount due', () => {
    const view = buildSessionView(
      record({ status: 'closed_unpaid', exitedAt: t('15:20'), amountDueKopecks: 6000 }),
      { now: t('15:30'), tariff },
    );
    expect(view.amountDueKopecks).toBe(6000);
  });

  it('info timers have no sync label; stored location and air raid are passed through', () => {
    const view = buildSessionView(
      record({ source: 'info_timer', providerRef: null, level: '-2', spot: 'C' }),
      {
        now: t('14:20'),
        tariff,
        airRaid: { startedAt: t('14:10'), freeExitMinutes: 30 },
      },
    );
    expect(view).toMatchObject({ lastSyncedAtLabel: null, level: '-2', spot: 'C' });
    expect(view.freeExitUntil).toEqual(t('14:40'));
  });

  it.each([
    [{}, { level: '-2', spot: 'C' }],
    [
      { level: '-1', spot: 'A' },
      { level: '-1', spot: 'A' },
    ],
    [
      { level: null, spot: null },
      { level: null, spot: null },
    ],
    [
      { level: '', spot: 'B' },
      { level: null, spot: 'B' },
    ],
  ])('merges the operator location report %j', (reported, expected) => {
    expect(mergeLocation({ level: '-2', spot: 'C' }, reported)).toEqual(expected);
  });
});
