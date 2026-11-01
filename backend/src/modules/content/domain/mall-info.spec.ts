import {
  EMPTY_MALL_INFO,
  type MallInfoDefaults,
  buildMallInfoView,
  effectiveMallHours,
  readFloorMaps,
  readLegalDocuments,
} from './mall-info';

const DEFAULTS: MallInfoDefaults = {
  name: 'Порт City',
  address: 'просп. Соборності, 43, Луцьк',
  website: 'https://portcity.com.ua',
  hours: '10:00-22:00',
  parkingUndergroundHours: '08:00-21:00',
  parkingSurfaceHours: '05:00-24:00',
  supportPhone: '+380332000000',
  supportEmail: null,
};
const NOW = new Date('2026-01-15T10:00:00.000Z');

describe('mall info', () => {
  it('reads JSON lists tolerantly', () => {
    expect(
      readLegalDocuments([
        { key: 'privacy', title: 'Політика', url: 'https://x/p' },
        { key: 'bad' },
        'nope',
      ]),
    ).toEqual([{ key: 'privacy', title: 'Політика', url: 'https://x/p' }]);
    expect(readLegalDocuments(null)).toEqual([]);
    expect(
      readFloorMaps([
        { floor: 3, url: 'https://x/3' },
        { floor: 1.5, url: 'https://x/bad' },
        { floor: -1, url: 'https://x/-1' },
      ]),
    ).toEqual([
      { floor: -1, url: 'https://x/-1' },
      { floor: 3, url: 'https://x/3' },
    ]);
  });

  it('prefers stored hours, then MALL_HOURS, then 10:00-22:00', () => {
    expect(effectiveMallHours({ hours: '09:00-21:00' }, '10:00-20:00')).toEqual({
      from: '09:00',
      to: '21:00',
    });
    expect(effectiveMallHours({ hours: null }, '10:00-20:00')).toEqual({
      from: '10:00',
      to: '20:00',
    });
    expect(effectiveMallHours(null, 'always')).toEqual({ from: '10:00', to: '22:00' });
  });

  it('shows the info desk and the parking operator only when something is stored', () => {
    const empty = buildMallInfoView(null, DEFAULTS, NOW, 'Europe/Kyiv');
    expect(empty).toMatchObject({ infoDesk: null, parkingOperator: null, telegramUrl: null });

    const stored = buildMallInfoView(
      { ...EMPTY_MALL_INFO, infoDeskHours: '10:00-22:00', parkingOperatorPhone: '+380500000000' },
      DEFAULTS,
      NOW,
      'Europe/Kyiv',
    );
    expect(stored.infoDesk).toEqual({ location: null, hours: '10:00-22:00' });
    expect(stored.parkingOperator).toEqual({ name: null, phone: '+380500000000', hours: null });
    expect(stored.support).toEqual({ phone: '+380332000000', email: null });
  });
});
