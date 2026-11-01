export { AdminModule } from './admin.module';
export { AdjustmentsService, toAdjustmentView } from './services/adjustments.service';
export type {
  ListAdjustmentsFilter,
  ListQuery,
  RequestAdjustmentInput,
} from './services/adjustments.service';
export { AuditLogService, toAuditLogView } from './services/audit-log.service';
export type { AuditListQuery } from './services/audit-log.service';
export { FeatureFlagsAdminService } from './services/feature-flags-admin.service';
export type { FeatureFlagWriteInput } from './services/feature-flags-admin.service';
export { ReportsService } from './services/reports.service';
export {
  SupportRequestsService,
  toAdminSupportRequestDto,
  toSupportRequestDto,
} from './services/support-requests.service';
export type {
  CreateSupportRequestInput,
  SupportListFilter,
  UpdateSupportRequestInput,
} from './services/support-requests.service';
export {
  SUPPORT_TRANSITIONS,
  assertSupportStatusChange,
  canChangeSupportStatus,
  isOwnSupportPhotoKey,
  supportPhotoPrefix,
} from './domain/support-rules';
export { AdminErrors } from './domain/errors';
export type { AdminErrorKey } from './domain/errors';
export {
  ACCOUNT_SELF_APPROVAL_WINDOW_MS,
  ADJUSTMENT_TRANSITIONS,
  MAX_ADJUSTMENT_POINTS,
  SECOND_APPROVAL_REASONS,
  adjustmentIdempotencyKey,
  canTransition,
  needsSecondApproval,
  planAdjustmentRequest,
  secondApprovalReasonFor,
} from './domain/adjustment-rules';
export type {
  AdjustmentRequestPlan,
  LedgerOperation,
  SecondApprovalReason,
  SelfApprovedTotals,
} from './domain/adjustment-rules';
export {
  DAY_KEY_PATTERN,
  MAX_REPORT_RANGE_DAYS,
  REPORT_SECTIONS,
  REPORT_SOURCES,
  buildDailyReport,
  isValidDayKey,
  kyivDayRange,
  previousKyivDay,
} from './domain/daily-report';
export type {
  AdjustmentDailyStats,
  DailyReport,
  ReportSection,
  ReportSource,
} from './domain/daily-report';
export { normaliseAuditFilter, parseAuditAction } from './domain/audit-filter';
export type { AuditActionMatch, AuditFilter } from './domain/audit-filter';
export {
  FEATURE_FLAG_KEY_PATTERN,
  isValidFeatureFlagKey,
  nextFeatureFlagState,
} from './domain/feature-flag-rules';
export type { FeatureFlagSnapshot, FeatureFlagUpdate } from './domain/feature-flag-rules';
export { ADMIN_ROLE_SETS } from './domain/roles';
export type { AdjustmentView, AdminActor, AuditLogView } from './domain/views';
export {
  DEFAULT_CATCH_UP_DAYS,
  REPORTS_NIGHTLY_CRON,
  REPORTS_NIGHTLY_JOBS,
  REPORTS_NIGHTLY_SCHEDULE_ID,
  runReportsNightly,
} from './jobs/reports-nightly.job';
export type {
  ReportsNightlyDeps,
  ReportsNightlyJobData,
  ReportsNightlyOutcome,
} from './jobs/reports-nightly.job';
