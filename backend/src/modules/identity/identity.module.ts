import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { AdminAccessGate } from '../../common/auth/admin-access';
import { APP_CONFIG } from '../../common/config';
import { IDENTITY_PORT } from '../../common/contracts/identity';
import { QUEUES } from '../../common/queue/queue.constants';
import { QueueModule } from '../../common/queue/queue.module';
import { WorkerSchedules } from '../../common/queue/worker-schedules.service';
import { AdminAuthController } from './controllers/admin-auth.controller';
import { AdminStaffController } from './controllers/admin-staff.controller';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AuthController } from './controllers/auth.controller';
import { LegalController } from './controllers/legal.controller';
import { MeController } from './controllers/me.controller';
import { IDENTITY_CONFIG, type IdentityConfig, identityConfigProvider } from './identity.config';
import { ACCOUNT_DELETION_JOBS, ACCOUNT_DELETION_SCHEDULE_ID } from './jobs/account-deletion.job';
import { AccountDeletionProcessor } from './jobs/account-deletion.processor';
import { AccountDeletionService } from './services/account-deletion.service';
import { AdminAuthService } from './services/admin-auth.service';
import { AdminStaffService } from './services/admin-staff.service';
import { AdminUsersService } from './services/admin-users.service';
import { AuthService } from './services/auth.service';
import { CaptchaVerifierPort, NoopCaptchaVerifier } from './services/captcha.port';
import { ChildrenService } from './services/children.service';
import { DevicesService } from './services/devices.service';
import { IdentityPortService } from './services/identity-port.service';
import { IdentityStore } from './services/identity.store';
import { PrismaIdentityStore } from './services/prisma-identity.store';
import { ProfileService } from './services/profile.service';
import { SessionService } from './services/session.service';
import { createSmsAdapter } from './services/sms.factory';
import { SmsPort } from './services/sms.port';

/**
 * Identity: OTP login, member sessions (access JWT + rotating refresh tokens), profile,
 * consents, devices, account deletion (daily `account-deletion` queue), personal data export,
 * back-office login with optional TOTP, member lookup and back-office accounts.
 * Provides IDENTITY_PORT (IdentityPortService). Depends on the common layer only; consumed by
 * club, notifications and admin. Publishes user.* outbox events (see README).
 */
@Module({
  imports: [QueueModule.registerQueue(QUEUES.accountDeletion)],
  controllers: [
    AuthController,
    MeController,
    LegalController,
    AdminAuthController,
    AdminUsersController,
    AdminStaffController,
  ],
  providers: [
    identityConfigProvider,
    { provide: IdentityStore, useClass: PrismaIdentityStore },
    { provide: SmsPort, inject: [IDENTITY_CONFIG, APP_CONFIG], useFactory: createSmsAdapter },
    // Replace with a real provider adapter (reCAPTCHA Enterprise, Turnstile, hCaptcha) when chosen.
    { provide: CaptchaVerifierPort, useClass: NoopCaptchaVerifier },
    SessionService,
    DevicesService,
    AuthService,
    ProfileService,
    ChildrenService,
    AccountDeletionService,
    AdminAuthService,
    AdminUsersService,
    AdminStaffService,
    IdentityPortService,
    AccountDeletionProcessor,
    { provide: IDENTITY_PORT, useExisting: IdentityPortService },
  ],
  exports: [IDENTITY_PORT, IdentityPortService],
})
export class IdentityModule implements OnModuleInit {
  constructor(
    private readonly schedules: WorkerSchedules,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
    private readonly adminAccess: AdminAccessGate,
    private readonly port: IdentityPortService,
  ) {}

  onModuleInit(): void {
    // The shared AdminGuard (common layer) asks identity whether the admin behind a token is
    // still active and still has the token's role (cached ADMIN_ACCESS_CACHE_SECONDS).
    this.adminAccess.useResolver((adminId) => this.port.getAdminAccess(adminId));
    this.schedules.register({
      id: ACCOUNT_DELETION_SCHEDULE_ID,
      queue: QUEUES.accountDeletion,
      jobName: ACCOUNT_DELETION_JOBS.run,
      pattern: this.config.ACCOUNT_DELETION_CRON,
    });
  }
}
