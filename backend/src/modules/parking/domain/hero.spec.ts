import type { ParkingSessionStatus } from '../../../common/contracts/parking';
import { type HeroSessionFacts, type HeroState, heroActions, heroState } from './hero';

const t = (hhmm: string): Date => new Date(`2026-01-15T${hhmm}:00.000+02:00`);

function session(
  status: ParkingSessionStatus,
  extra: Partial<HeroSessionFacts> = {},
): HeroSessionFacts {
  return {
    source: 'provider',
    status,
    enteredAt: t('14:00'),
    paidUntil: status === 'paid' || status === 'overstay' ? t('16:00') : null,
    exitedAt: status.startsWith('closed') ? t('15:52') : null,
    ...extra,
  };
}

describe('heroState', () => {
  it.each([
    ['F0', 'full', false, null, '15:00'],
    ['F1', 'full', true, null, '15:00'],
    ['F2', 'full', true, session('open'), '14:11'],
    ['F3', 'full', true, session('payable'), '15:20'],
    ['F4', 'full', true, session('paid'), '15:25'],
    ['F5', 'full', true, session('overstay'), '16:05'],
    ['F6', 'full', true, session('closed'), '16:00'],
    ['F6', 'full', true, session('closed_unpaid'), '16:00'],
    ['F6', 'full', true, session('closed_free'), '16:00'],
    ['F1', 'full', true, session('closed'), '17:53'],
    ['F7', 'full', true, session('payable'), '19:01'],
    ['F7', 'full', true, session('overstay'), '18:01'],
    ['F5', 'full', true, session('overstay'), '17:59'],
    ['I0', 'info', true, null, '15:00'],
    ['I0', 'info', false, null, '15:00'],
    ['I1', 'info', true, session('open', { source: 'info_timer' }), '14:11'],
    ['I2', 'info', true, session('payable', { source: 'info_timer' }), '15:20'],
    ['I3', 'info', true, session('paid', { source: 'info_timer' }), '15:25'],
    ['I3', 'info', true, session('overstay', { source: 'info_timer' }), '16:05'],
    ['I4', 'info', true, session('closed', { source: 'info_timer' }), '16:00'],
    ['I0', 'info', true, session('closed', { source: 'info_timer' }), '18:00'],
    // An operator session shows full-mode states even while the timer mode is on.
    ['F3', 'info', true, session('payable'), '15:20'],
  ] as const)('%s (mode %s, vehicles %s) at %s', (expected, mode, hasVehicles, facts, now) => {
    const actual: HeroState = heroState({ mode, hasVehicles, session: facts, now: t(now) });
    expect(actual).toBe(expected);
  });
});

describe('heroState: F7 counts from «Так, я тут» (finding 9)', () => {
  it.each([
    // Payable since 14:00: F7 after 19:00, unless presence was confirmed later.
    ['F7', session('payable'), '19:30'],
    ['F3', session('payable', { presenceConfirmedAt: t('19:10') }), '19:30'],
    ['F3', session('payable', { presenceConfirmedAt: t('19:10') }), '23:09'],
    ['F7', session('payable', { presenceConfirmedAt: t('14:30') }), '19:31'],
    // Overstay since 16:00: F7 after 18:00, or 2 h after the confirmation.
    ['F7', session('overstay'), '18:30'],
    ['F5', session('overstay', { presenceConfirmedAt: t('18:10') }), '18:30'],
    ['F7', session('overstay', { presenceConfirmedAt: t('18:10') }), '20:11'],
  ] as const)('%s for %j at %s', (expected, facts, now) => {
    expect(heroState({ mode: 'full', hasVehicles: true, session: facts, now: t(now) })).toBe(
      expected,
    );
  });
});

describe('heroActions', () => {
  it.each([
    ['F0', true, true, true, ['add_vehicle', 'start_timer']],
    ['F0', true, false, false, ['add_vehicle']],
    ['F1', true, false, true, ['verify_vehicle']],
    // verify_vehicle only while some vehicle is unverified (finding 14).
    ['F1', true, false, false, []],
    ['F1', true, true, false, ['start_timer']],
    ['F2', true, false, false, ['left']],
    ['F3', true, false, false, ['pay', 'left']],
    ['F3', false, false, true, ['verify_vehicle']],
    ['F4', true, false, false, []],
    ['F5', true, false, false, ['pay', 'left']],
    ['F6', true, false, false, []],
    ['F7', true, false, false, ['pay', 'confirm_present', 'left']],
    ['F7', false, false, true, ['verify_vehicle']],
    ['I0', true, true, false, ['start_timer']],
    ['I1', true, true, false, ['exit_timer']],
    ['I2', true, true, false, ['paid_at_paymat', 'exit_timer']],
    ['I3', true, true, false, ['paid_at_paymat', 'exit_timer']],
    ['I4', true, true, false, ['start_timer']],
  ] as const)(
    '%s verified=%s info=%s unverifiedVehicles=%s',
    (state, verified, infoModeEnabled, hasUnverifiedVehicles, expected) => {
      expect(heroActions(state, { verified, infoModeEnabled, hasUnverifiedVehicles })).toEqual(
        expected,
      );
    },
  );
});
