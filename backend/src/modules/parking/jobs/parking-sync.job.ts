import type { ProviderSessionSnapshot } from '../provider/parking-provider.port';

export interface ParkingSyncDeps {
  /** The operator's active sessions; throws when the operator is unavailable. */
  listActiveSnapshots(): Promise<ProviderSessionSnapshot[]>;
  /** Keeps only snapshots of member plates and of sessions already stored. */
  filterTracked(snapshots: ProviderSessionSnapshot[]): Promise<ProviderSessionSnapshot[]>;
  applySnapshot(snapshot: ProviderSessionSnapshot): Promise<{ changed: boolean; events: string[] }>;
  /** Stored active operator sessions missing from the active list (exits, unknown refs). */
  reconcileMissing(
    seenRefs: readonly string[],
  ): Promise<{ checked: number; closed: number; failed: number }>;
  tickInfoTimers(): Promise<{ checked: number; changed: number; closed: number }>;
  log?: (message: string) => void;
}

export interface ParkingSyncSummary {
  providerAvailable: boolean;
  /** Active sessions reported by the operator. */
  seen: number;
  /** Of those, sessions of member plates (stored). */
  tracked: number;
  changed: number;
  events: number;
  failed: number;
  missingChecked: number;
  missingClosed: number;
  infoTimersChecked: number;
  infoTimersChanged: number;
  infoTimersClosed: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Handler logic of the `parking-sync` job (brief section 9, every 60 s via the provider port):
 * 1. pull the operator's active sessions and store the ones of member plates (state transitions,
 *    reminders and outbox events happen in SessionSyncService.applySnapshot);
 * 2. fetch the final facts of stored sessions the operator no longer lists (the car left);
 * 3. re-evaluate info-mode timers.
 * An unavailable operator skips steps 1-2 without failing the job (the app degrades to the
 * timer); one failing session never stops the batch. Plain function: the processor only wires it.
 */
export async function runParkingSync(deps: ParkingSyncDeps): Promise<ParkingSyncSummary> {
  const summary: ParkingSyncSummary = {
    providerAvailable: true,
    seen: 0,
    tracked: 0,
    changed: 0,
    events: 0,
    failed: 0,
    missingChecked: 0,
    missingClosed: 0,
    infoTimersChecked: 0,
    infoTimersChanged: 0,
    infoTimersClosed: 0,
  };

  let snapshots: ProviderSessionSnapshot[] | null = null;
  try {
    snapshots = await deps.listActiveSnapshots();
  } catch (error) {
    summary.providerAvailable = false;
    deps.log?.(`parking-sync: operator unavailable, provider sessions skipped: ${message(error)}`);
  }

  if (snapshots) {
    summary.seen = snapshots.length;
    const tracked = await deps.filterTracked(snapshots);
    summary.tracked = tracked.length;
    for (const snapshot of tracked) {
      try {
        const result = await deps.applySnapshot(snapshot);
        if (result.changed) {
          summary.changed += 1;
        }
        summary.events += result.events.length;
      } catch (error) {
        summary.failed += 1;
        deps.log?.(`parking-sync: session ${snapshot.providerRef} failed: ${message(error)}`);
      }
    }
    try {
      const missing = await deps.reconcileMissing(snapshots.map((item) => item.providerRef));
      summary.missingChecked = missing.checked;
      summary.missingClosed = missing.closed;
      summary.failed += missing.failed;
    } catch (error) {
      summary.failed += 1;
      deps.log?.(`parking-sync: reconciliation of missing sessions failed: ${message(error)}`);
    }
  }

  try {
    const timers = await deps.tickInfoTimers();
    summary.infoTimersChecked = timers.checked;
    summary.infoTimersChanged = timers.changed;
    summary.infoTimersClosed = timers.closed;
  } catch (error) {
    summary.failed += 1;
    deps.log?.(`parking-sync: info timers failed: ${message(error)}`);
  }

  return summary;
}
