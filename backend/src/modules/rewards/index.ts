export { RewardsModule } from './rewards.module';
export { VoucherService, voucherLifecyclePayload } from './services/voucher.service';
export type {
  ActivationResult,
  AdminVoucherListQuery,
  SystemCancelResult,
  VoucherListQuery,
} from './services/voucher.service';
export { RedemptionService } from './services/redemption.service';
export type { RedeemResult } from './services/redemption.service';
export { RewardsCatalogueService } from './services/rewards-catalogue.service';
export { ValidatorService } from './services/validator.service';
export type { ValidatorPrincipal } from './services/validator.service';
export { ValidatorDevicesService } from './services/validator-devices.service';
export { AdminVouchersService } from './services/admin-vouchers.service';
export { RewardsRepository } from './services/rewards.repository';
export { toVoucherSummary, toVoucherView } from './services/voucher.mapper';
export type { VoucherView } from './services/voucher.mapper';
export {
  parseStaticVoucherQr,
  signStaticVoucherQr,
  voucherDisplayNumber,
} from './domain/static-qr';
export { REWARDS_CONFIG, rewardsEnvSchema, DEFAULT_REWARDS_CONFIG } from './rewards.config';
export type { RewardsConfig } from './rewards.config';
export { RewardsErrors } from './domain/errors';
export {
  VOUCHER_FINAL_STATUSES,
  VOUCHER_LIVE_STATUSES,
  canTransitionVoucher,
  effectiveVoucherStatus,
  isFinalVoucherStatus,
  isLiveVoucherStatus,
  nextVoucherStatus,
  planSweepAction,
} from './domain/voucher-state';
export {
  computeActivationWindow,
  generateActivationCode,
  normalizeActivationCode,
  parseActivationToken,
  signActivationToken,
} from './domain/activation';
export { REWARDS_JOBS, VOUCHERS_EXPIRE_EVERY_MS } from './jobs/job-names';
export { runVouchersExpire } from './jobs/vouchers-expire.job';
export type { VouchersExpireDeps, VouchersExpireSummary } from './jobs/vouchers-expire.job';
export { REWARDS_OUTBOX_ROUTES, handleRewardsEventJob } from './jobs/rewards-events.handler';
export {
  REWARD_KINDS,
  VOUCHER_ISSUER_PORT,
  VOUCHER_KINDS,
  VOUCHER_STATUSES,
  type IssueVoucherInput,
  type CancelVoucherInput,
  type VoucherIssuerPort,
  type VoucherSummary,
} from '../../common/contracts/rewards';
