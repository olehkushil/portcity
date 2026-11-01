import { DEFAULT_PARKING_TARIFF } from '../../../common/contracts/parking';
import { parkingNotices } from './notices';

const t = (hhmm: string): Date => new Date(`2026-01-15T${hhmm}:00.000+02:00`);

describe('parkingNotices', () => {
  it.each([
    ['no session at 20:40', null, false, '20:40', []],
    ['air raid without a session', null, true, '12:00', ['air_raid']],
    ['underground at 20:29', 'underground', false, '20:29', []],
    ['underground at 20:30', 'underground', false, '20:30', ['underground_closing_soon']],
    ['underground at 20:59', 'underground', false, '20:59', ['underground_closing_soon']],
    ['underground at 21:00', 'underground', false, '21:00', ['underground_closed']],
    ['underground at 07:59', 'underground', false, '07:59', ['underground_closed']],
    ['underground at 08:00', 'underground', false, '08:00', []],
    ['surface at 20:40', 'surface', false, '20:40', []],
    ['surface at 23:30', 'surface', false, '23:30', ['night_tariff_soon']],
    ['surface at 23:59', 'surface', false, '23:59', ['night_tariff_soon']],
    ['surface at 00:00', 'surface', false, '00:00', []],
    [
      'underground at 23:45 in an alert',
      'underground',
      true,
      '23:45',
      ['air_raid', 'underground_closed', 'night_tariff_soon'],
    ],
  ] as const)('%s', (_case, zone, airRaidActive, now, expected) => {
    expect(
      parkingNotices({
        now: t(now),
        tariff: DEFAULT_PARKING_TARIFF,
        airRaidActive,
        activeZone: zone,
      }),
    ).toEqual(expected);
  });
});
