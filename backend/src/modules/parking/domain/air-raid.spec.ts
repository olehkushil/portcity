import {
  airRaidCloseReason,
  airRaidView,
  freeExitUntil,
  isFreeExit,
  parseAirRaidFlag,
} from './air-raid';

const t = (hhmm: string): Date => new Date(`2026-01-15T${hhmm}:00.000+02:00`);

describe('air-raid rule', () => {
  const alert = { startedAt: t('15:00'), freeExitMinutes: 30 };

  describe('parseAirRaidFlag', () => {
    it.each([
      ['missing flag', null, null],
      ['disabled flag', { enabled: false, payload: null, updatedAt: t('15:00') }, null],
    ])('%s -> no alert', (_case, flag, expected) => {
      expect(parseAirRaidFlag(flag, 30)).toBe(expected);
    });

    it('uses payload.startedAt and payload.freeExitMinutes when valid', () => {
      expect(
        parseAirRaidFlag(
          {
            enabled: true,
            payload: { startedAt: t('14:50').toISOString(), freeExitMinutes: 20 },
            updatedAt: t('15:00'),
          },
          30,
        ),
      ).toEqual({ startedAt: t('14:50'), freeExitMinutes: 20 });
    });

    it('falls back to updatedAt and the configured window', () => {
      expect(
        parseAirRaidFlag(
          {
            enabled: true,
            payload: { startedAt: 'nonsense', freeExitMinutes: -1 },
            updatedAt: t('15:00'),
          },
          30,
        ),
      ).toEqual({ startedAt: t('15:00'), freeExitMinutes: 30 });
    });
  });

  it.each([
    ['14:59', false],
    ['15:00', true],
    ['15:29', true],
    ['15:30', true],
    ['15:31', false],
  ])('exit at %s free: %s', (hhmm, expected) => {
    expect(isFreeExit(alert, t(hhmm))).toBe(expected);
  });

  it('no alert, no free exit', () => {
    expect(isFreeExit(null, t('15:10'))).toBe(false);
    expect(freeExitUntil(alert)).toEqual(t('15:30'));
  });

  it.each([
    ['plain exit with an amount due', 'exit', 2000, 'air_raid'],
    ['member said "I already left"', 'user_left', 2000, 'air_raid'],
    ['nothing due (already paid)', 'exit', 0, null],
    ['operator privilege stays', 'privilege', 2000, null],
    ['unknown reason', null, 2000, 'air_raid'],
  ] as const)('%s -> %s', (_case, reason, due, expected) => {
    expect(airRaidCloseReason(alert, t('15:10'), reason, due)).toBe(expected);
  });

  it('view: active alert with the free window open or closed', () => {
    expect(airRaidView(null, t('15:10'))).toEqual({
      active: false,
      startedAt: null,
      freeExitUntil: null,
      freeExitOpen: false,
    });
    expect(airRaidView(alert, t('15:10'))).toMatchObject({ active: true, freeExitOpen: true });
    expect(airRaidView(alert, t('15:40'))).toMatchObject({ active: true, freeExitOpen: false });
  });
});
