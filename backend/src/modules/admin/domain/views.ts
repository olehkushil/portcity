import type { ManualAdjustmentStatus } from '../../../common/contracts/admin';
import type { ActorType, Points, Uuid } from '../../../common/contracts/shared';
import type { SecondApprovalReason } from './adjustment-rules';

/** Read model of a manual adjustment returned by every /admin/adjustments endpoint. */
export interface AdjustmentView {
  id: Uuid;
  accountId: Uuid;
  userId: Uuid;
  /** Signed points. */
  amount: Points;
  reason: string;
  status: ManualAdjustmentStatus;
  /** A second admin had (or has) to approve: see `secondApprovalReason`. */
  needsSecondApproval: boolean;
  /** Null when the requester decided alone. */
  secondApprovalReason: SecondApprovalReason | null;
  thresholdPoints: Points;
  requestedById: Uuid;
  approvedById: Uuid | null;
  /** Ledger row written when the adjustment was applied. */
  pointsTxId: Uuid | null;
  rejectionReason: string | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Read model of an audit_logs row. */
export interface AuditLogView {
  id: Uuid;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  createdAt: Date;
}

/** Back-office principal performing an audited action (from the admin access token). */
export interface AdminActor {
  id: Uuid;
  ip?: string | null;
}
