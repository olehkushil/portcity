/** Public surface of the receipts module. Other modules consume RECEIPTS_PORT by DI token. */
export {
  RECEIPTS_PORT,
  RECEIPT_ERROR_CODES,
  RECEIPT_SOURCES,
  RECEIPT_STATUSES,
  RISK_FLAGS,
} from '../../common/contracts/receipts';
export type {
  ReceiptDailyStats,
  ReceiptErrorCode,
  ReceiptSource,
  ReceiptStatus,
  ReceiptSubmissionOutcome,
  ReceiptSubmissionResult,
  ReceiptSummary,
  ReceiptsPort,
  RiskFlag,
} from '../../common/contracts/receipts';
export { ReceiptErrors } from './domain/errors';
export { QrParseError, isQrParseError, parseTaxQr, parseTaxQrOrThrow } from './domain/qr-parser';
export type { ParsedTaxQr, QrParseErrorCode, QrParseResult } from './domain/qr-parser';
export { buildCreditPlan, computePoints, evaluateReceipt } from './domain/rules';
export type { ReceiptDecision, ReceiptRuleInput } from './domain/rules';
export { RECEIPT_TRANSITIONS, canTransition } from './domain/state-machine';
export { SUBMISSION_SCREENS } from './domain/submission-view';
export type { SubmissionScreen } from './domain/submission-view';
export {
  RECEIPTS_PROCESS_JOBS,
  RECEIPTS_PROCESS_JOB_OPTIONS,
  handleReceiptsProcessJob,
} from './jobs/receipts-process.job';
export {
  ERASED_APPEAL_MESSAGE_UK,
  RECEIPTS_OUTBOX_ROUTES,
  handleReceiptsEventJob,
} from './jobs/receipts-events.handler';
export { ReceiptsModule } from './receipts.module';
export { ReceiptModerationService } from './services/receipt-moderation.service';
export { ReceiptPipelineService } from './services/receipt-pipeline.service';
export { ReceiptSubmissionService } from './services/receipt-submission.service';
export { ReceiptsPortService } from './services/receipts-port.service';
