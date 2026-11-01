import { MINUTE_MS } from './tariff';

/**
 * Source of the alert in Release 1: the feature flag FEATURE_FLAG_KEYS.parkingAirRaid
 * (`parking.air_raid`, payload ParkingAirRaidFlagPayload) that the duty officer switches on
 * (design brief 4.3).
 *
 * Operator's rule: during an air-raid alert the entry is closed and the exit is free during the
 * first `freeExitMinutes` of the alert. Sessions that leave inside that window close as
 * `closed_free` with the reason `air_raid`.
 */
export interface AirRaidAlert {
  startedAt: Date;
  freeExitMinutes: number;
}

/** The flag row as FeatureFlagsPort returns it. */
export interface AirRaidFlagView {
  enabled: boolean;
  payload: Record<string, unknown> | null;
  updatedAt: Date;
}

/**
 * Reads the alert from the flag: `enabled` turns it on; `payload.startedAt` (ISO) is the alert
 * start, falling back to the moment the flag was last changed; `payload.freeExitMinutes`
 * overrides the configured window.
 */
export function parseAirRaidFlag(
  flag: AirRaidFlagView | null,
  defaultFreeExitMinutes: number,
): AirRaidAlert | null {
  if (!flag || !flag.enabled) {
    return null;
  }
  const payload = flag.payload ?? {};
  const rawStart = payload['startedAt'];
  const parsedStart = typeof rawStart === 'string' ? new Date(rawStart) : null;
  const startedAt =
    parsedStart && !Number.isNaN(parsedStart.getTime()) ? parsedStart : flag.updatedAt;
  const rawMinutes = payload['freeExitMinutes'];
  const freeExitMinutes =
    typeof rawMinutes === 'number' && Number.isInteger(rawMinutes) && rawMinutes >= 0
      ? rawMinutes
      : defaultFreeExitMinutes;
  return { startedAt, freeExitMinutes };
}

/** End of the free-exit window («Вільний виїзд до HH:MM»). */
export function freeExitUntil(alert: AirRaidAlert): Date {
  return new Date(alert.startedAt.getTime() + alert.freeExitMinutes * MINUTE_MS);
}

/** True when an exit at `exitedAt` falls inside the free-exit window of the alert. */
export function isFreeExit(alert: AirRaidAlert | null, exitedAt: Date): boolean {
  if (!alert) {
    return false;
  }
  const at = exitedAt.getTime();
  return at >= alert.startedAt.getTime() && at <= freeExitUntil(alert).getTime();
}

/**
 * Close reason to record for an exit: `air_raid` when the exit is inside the free window and
 * something would otherwise be due; null keeps the reason reported by the operator.
 * Only plain exits are reinterpreted (an operator's own `privilege` or `timeout` stays).
 */
export function airRaidCloseReason(
  alert: AirRaidAlert | null,
  exitedAt: Date,
  reportedReason: string | null,
  amountDueAtExitKopecks: number,
): 'air_raid' | null {
  if (amountDueAtExitKopecks <= 0 || !isFreeExit(alert, exitedAt)) {
    return null;
  }
  if (reportedReason !== null && !PLAIN_EXIT_REASONS.includes(reportedReason)) {
    return null;
  }
  return 'air_raid';
}

const PLAIN_EXIT_REASONS: readonly string[] = ['exit', 'user_left', 'user_exit'];

/** What the hero shows while an alert is on. */
export interface AirRaidView {
  active: boolean;
  startedAt: Date | null;
  freeExitUntil: Date | null;
  /** True while the free-exit window is still open. */
  freeExitOpen: boolean;
}

export function airRaidView(alert: AirRaidAlert | null, now: Date): AirRaidView {
  if (!alert) {
    return { active: false, startedAt: null, freeExitUntil: null, freeExitOpen: false };
  }
  const until = freeExitUntil(alert);
  return {
    active: true,
    startedAt: alert.startedAt,
    freeExitUntil: until,
    freeExitOpen: now.getTime() >= alert.startedAt.getTime() && now.getTime() <= until.getTime(),
  };
}
