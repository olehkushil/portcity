export { IdentityModule } from './identity.module';
export { IdentityPortService } from './services/identity-port.service';
export { IdentityStore, StoreConflictError } from './services/identity.store';
export type { IdentityReads, IdentityUow, IdentityWrites } from './services/identity.store';
export { PrismaIdentityStore } from './services/prisma-identity.store';
export { SmsPort, LogSmsAdapter } from './services/sms.port';
export { CaptchaVerifierPort, NoopCaptchaVerifier } from './services/captcha.port';
export type { CaptchaCheck } from './services/captcha.port';
export type { SmsMessage } from './services/sms.port';
export { TurboSmsAdapter } from './services/turbosms.adapter';
export { IDENTITY_CONFIG, identityEnvSchema, parseStaticOtpCodes } from './identity.config';
export type { IdentityConfig } from './identity.config';
export { IdentityErrors } from './domain/errors';
export { ACCOUNT_DELETION_JOBS, ACCOUNT_DELETION_SCHEDULE_ID } from './jobs/account-deletion.job';
export {
  formatMemberCode,
  generateMemberCode,
  hasValidCheckDigit,
  isWellFormedMemberCode,
} from './domain/member-code';
export { anonymisedPhone, isAnonymisedPhone } from './domain/deletion';
// Test doubles (not exported here on purpose): ./testing/in-memory-identity.store.ts,
// ./testing/in-memory-sms.adapter.ts.
