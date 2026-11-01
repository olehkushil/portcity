import type { ParkingSessionSource, ParkingSessionStatus } from '../../../common/contracts/parking';
import { isFinalStatus } from './session-state';
import { HOUR_MS } from './tariff';

/**
 * States of the parking hero card (design brief section 4):
 * full mode  F0 no vehicle, F1 vehicle without a session, F2 free (`open`), F3 to pay (`payable`),
 *            F4 paid, F5 overstay, F6 closed (all three closed statuses, for 2 h after the exit),
 *            F7 "are you still here?" (payable 5 h after the entry, or overstaying for 2 h);
 * info mode  I0 no timer, I1 free, I2 paid time, I3 paid at the paymat (also when it runs out),
 *            I4 left (for 2 h after the exit).
 */
export const HERO_STATES = [
  'F0',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'I0',
  'I1',
  'I2',
  'I3',
  'I4',
] as const;
export type HeroState = (typeof HERO_STATES)[number];

export const PARKING_MODES = ['full', 'info'] as const;
export type ParkingMode = (typeof PARKING_MODES)[number];

/** API actions the hero may offer (client-only actions such as "where is my car" are not listed). */
export const HERO_ACTIONS = [
  'add_vehicle',
  'verify_vehicle',
  'pay',
  'left',
  'start_timer',
  'paid_at_paymat',
  'exit_timer',
  /** F7 «Так, я тут»: POST /parking/session/:id/still-here. */
  'confirm_present',
] as const;
export type HeroAction = (typeof HERO_ACTIONS)[number];

export interface HeroSessionFacts {
  source: ParkingSessionSource;
  /** Status derived at `now` (stored status for closed sessions). */
  status: ParkingSessionStatus;
  enteredAt: Date;
  paidUntil: Date | null;
  exitedAt: Date | null;
  /** Last «Так, я тут»: the F7 thresholds count from it when it is later than their usual start. */
  presenceConfirmedAt?: Date | null;
}

/** Start of the F7 clock: the usual reference, or the last presence confirmation if later. */
export function stillInsideReference(base: Date, presenceConfirmedAt?: Date | null): Date {
  return presenceConfirmedAt && presenceConfirmedAt.getTime() > base.getTime()
    ? presenceConfirmedAt
    : base;
}

export interface HeroTimings {
  /** How long a closed session stays on the hero (F6 / I4). */
  recentClosedHours: number;
  stillInsidePayableHours: number;
  stillInsideOverstayHours: number;
}

export const DEFAULT_HERO_TIMINGS: HeroTimings = Object.freeze({
  recentClosedHours: 2,
  stillInsidePayableHours: 5,
  stillInsideOverstayHours: 2,
});

/** True while a closed session should still be shown (F6 / I4). */
export function isRecentlyClosed(
  session: Pick<HeroSessionFacts, 'status' | 'exitedAt'>,
  now: Date,
  timings: HeroTimings = DEFAULT_HERO_TIMINGS,
): boolean {
  if (!isFinalStatus(session.status) || !session.exitedAt) {
    return false;
  }
  return now.getTime() - session.exitedAt.getTime() <= timings.recentClosedHours * HOUR_MS;
}

/**
 * Picks the hero state. `session` is the session to show (an active one, or a recently closed
 * one); null or an old closed session means "no session".
 */
export function heroState(input: {
  mode: ParkingMode;
  hasVehicles: boolean;
  session: HeroSessionFacts | null;
  now: Date;
  timings?: HeroTimings;
}): HeroState {
  const timings = input.timings ?? DEFAULT_HERO_TIMINGS;
  const { session, now } = input;
  const visible =
    session && (!isFinalStatus(session.status) || isRecentlyClosed(session, now, timings))
      ? session
      : null;

  if (!visible) {
    if (input.mode === 'info') {
      return 'I0';
    }
    return input.hasVehicles ? 'F1' : 'F0';
  }

  if (visible.source === 'info_timer') {
    switch (visible.status) {
      case 'open':
        return 'I1';
      case 'payable':
        return 'I2';
      case 'paid':
      case 'overstay':
        return 'I3';
      default:
        return 'I4';
    }
  }

  switch (visible.status) {
    case 'open':
      return 'F2';
    case 'payable': {
      const since = stillInsideReference(visible.enteredAt, visible.presenceConfirmedAt);
      return now.getTime() - since.getTime() > timings.stillInsidePayableHours * HOUR_MS
        ? 'F7'
        : 'F3';
    }
    case 'paid':
      return 'F4';
    case 'overstay': {
      if (!visible.paidUntil) {
        return 'F5';
      }
      const since = stillInsideReference(visible.paidUntil, visible.presenceConfirmedAt);
      return now.getTime() - since.getTime() > timings.stillInsideOverstayHours * HOUR_MS
        ? 'F7'
        : 'F5';
    }
    default:
      return 'F6';
  }
}

/**
 * Endpoints the hero offers in a state. `verified` is false when the session belongs to an
 * unverified plate (only the amount and the paid period are visible, nothing can be paid);
 * `hasUnverifiedVehicles` says whether any of the member's cars still needs a talon or paymat
 * code (F1 offers `verify_vehicle` only then).
 */
export function heroActions(
  state: HeroState,
  options: { verified: boolean; infoModeEnabled: boolean; hasUnverifiedVehicles: boolean },
): HeroAction[] {
  const timer: HeroAction[] = options.infoModeEnabled ? ['start_timer'] : [];
  switch (state) {
    case 'F0':
      return ['add_vehicle', ...timer];
    case 'F1':
      return options.hasUnverifiedVehicles ? ['verify_vehicle', ...timer] : [...timer];
    case 'F2':
      return options.verified ? ['left'] : ['verify_vehicle'];
    case 'F3':
    case 'F5':
      return options.verified ? ['pay', 'left'] : ['verify_vehicle'];
    case 'F4':
      return options.verified ? [] : ['verify_vehicle'];
    case 'F7':
      return options.verified ? ['pay', 'confirm_present', 'left'] : ['verify_vehicle'];
    case 'F6':
      return [];
    case 'I0':
    case 'I4':
      return ['start_timer'];
    case 'I1':
      return ['exit_timer'];
    case 'I2':
      return ['paid_at_paymat', 'exit_timer'];
    case 'I3':
      return ['paid_at_paymat', 'exit_timer'];
  }
}
