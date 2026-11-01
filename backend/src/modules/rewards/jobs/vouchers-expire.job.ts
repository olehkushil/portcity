import {
  type SweepAction,
  type VoucherLifecycleSnapshot,
  planSweepAction,
} from '../domain/voucher-state';
import { VOUCHERS_EXPIRE_MAX_BATCHES } from './job-names';

export interface SweepCandidate extends VoucherLifecycleSnapshot {
  id: string;
}

export interface VouchersExpireDeps<V extends SweepCandidate> {
  now(): Date;
  batchSize: number;
  /** Default VOUCHERS_EXPIRE_MAX_BATCHES. */
  maxBatches?: number;
  /** Live vouchers whose activation lapsed or whose expiresAt passed at `now`. */
  findCandidates(now: Date, limit: number): Promise<V[]>;
  /** Applies the action with a conditional update; false when the row moved on meanwhile. */
  apply(voucher: V, action: Exclude<SweepAction, 'none'>, now: Date): Promise<boolean>;
  log?: (message: string) => void;
}

export interface VouchersExpireSummary {
  batches: number;
  scanned: number;
  /** issued|active -> expired (expiresAt reached), voucher.expired published. */
  expired: number;
  /** active -> issued (activation window lapsed, expiresAt not reached), code released. */
  deactivated: number;
  /** Rows that needed nothing or were changed concurrently. */
  skipped: number;
  failed: number;
}

/**
 * Handler logic of the minute `vouchers-expire` job (brief sections 6 and 9). One snapshot
 * time is used for the whole run; candidates are processed in batches until a batch is short
 * or makes no progress. Each voucher is applied in its own transaction, so one failure never
 * stops the sweep. Plain function: the processor only wires it.
 */
export async function runVouchersExpire<V extends SweepCandidate>(
  deps: VouchersExpireDeps<V>,
): Promise<VouchersExpireSummary> {
  const summary: VouchersExpireSummary = {
    batches: 0,
    scanned: 0,
    expired: 0,
    deactivated: 0,
    skipped: 0,
    failed: 0,
  };
  const now = deps.now();
  const maxBatches = deps.maxBatches ?? VOUCHERS_EXPIRE_MAX_BATCHES;
  const seen = new Set<string>();

  while (summary.batches < maxBatches) {
    const candidates = await deps.findCandidates(now, deps.batchSize);
    summary.batches += 1;
    let progressed = 0;
    for (const voucher of candidates) {
      if (seen.has(voucher.id)) {
        continue;
      }
      seen.add(voucher.id);
      summary.scanned += 1;
      const action = planSweepAction(voucher, now);
      if (action === 'none') {
        summary.skipped += 1;
        continue;
      }
      try {
        if (await deps.apply(voucher, action, now)) {
          progressed += 1;
          if (action === 'expire') {
            summary.expired += 1;
          } else {
            summary.deactivated += 1;
          }
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        summary.failed += 1;
        deps.log?.(
          `vouchers-expire: voucher ${voucher.id} (${action}) failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (candidates.length < deps.batchSize || progressed === 0) {
      break;
    }
  }

  if (summary.expired + summary.deactivated + summary.failed > 0) {
    deps.log?.(
      `vouchers-expire: scanned ${summary.scanned}, expired ${summary.expired}, deactivated ${summary.deactivated}, skipped ${summary.skipped}, failed ${summary.failed}`,
    );
  }
  return summary;
}
