import { TokenService } from '../../../common/auth/token.service';
import { type AppConfig, type RawEnv, cleanEnv, envSchema } from '../../../common/config';
import { parseEnvSection } from '../../../common/config/env-section';
import { FakeClock } from '../../../common/time/clock';
import { type IdentityConfig, identityEnvSchema } from '../identity.config';
import { AccountDeletionService } from '../services/account-deletion.service';
import { AdminAuthService } from '../services/admin-auth.service';
import { AdminStaffService } from '../services/admin-staff.service';
import { AdminUsersService } from '../services/admin-users.service';
import { AuthService } from '../services/auth.service';
import { type CaptchaCheck, CaptchaVerifierPort } from '../services/captcha.port';
import { ChildrenService } from '../services/children.service';
import { DevicesService, type LoginDeviceInfo } from '../services/devices.service';
import { IdentityPortService } from '../services/identity-port.service';
import { ProfileService } from '../services/profile.service';
import { SessionService } from '../services/session.service';
import { InMemoryIdentityStore } from './in-memory-identity.store';
import { InMemorySmsAdapter } from './in-memory-sms.adapter';

export const TEST_NOW = '2026-03-10T10:00:00.000Z';
export const TEST_PHONE = '+380501234567';
export const TEST_IP = '203.0.113.7';

/** Root configuration for unit tests, validated by the real schema (no global side effects). */
export function makeAppConfig(overrides: RawEnv = {}): AppConfig {
  return envSchema.parse(
    cleanEnv({
      NODE_ENV: 'test',
      PRISMA_LAZY_CONNECT: 'true',
      QUEUE_DRIVER: 'memory',
      JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef0123',
      OTP_PEPPER: 'unit-test-otp-pepper',
      ...overrides,
    }),
  );
}

/**
 * Identity configuration for unit tests: admin password hashes use scrypt ln=10 (production 17)
 * so tests stay fast, and the OTP resend cooldown is off so flows can log in repeatedly at one
 * fake instant (the cooldown has its own tests with OTP_RESEND_COOLDOWN_SECONDS set); everything
 * else keeps the production defaults unless overridden.
 */
export function makeIdentityConfig(overrides: RawEnv = {}): IdentityConfig {
  return parseEnvSection(identityEnvSchema, 'identity', {
    NODE_ENV: 'test',
    ADMIN_PASSWORD_SCRYPT_LOG_N: '10',
    OTP_RESEND_COOLDOWN_SECONDS: '0',
    ...overrides,
  });
}

/** Captcha hook double: records every check and answers `answer` (true by default). */
export class RecordingCaptchaVerifier extends CaptchaVerifierPort {
  readonly checks: CaptchaCheck[] = [];
  answer = true;

  verify(check: CaptchaCheck): Promise<boolean> {
    this.checks.push(check);
    return Promise.resolve(this.answer && check.token !== 'bad-token');
  }
}

export interface IdentityHarness {
  clock: FakeClock;
  store: InMemoryIdentityStore;
  sms: InMemorySmsAdapter;
  captcha: RecordingCaptchaVerifier;
  appConfig: AppConfig;
  config: IdentityConfig;
  tokens: TokenService;
  sessions: SessionService;
  devices: DevicesService;
  auth: AuthService;
  profiles: ProfileService;
  children: ChildrenService;
  deletions: AccountDeletionService;
  adminAuth: AdminAuthService;
  adminUsers: AdminUsersService;
  adminStaff: AdminStaffService;
  port: IdentityPortService;
}

export interface HarnessOptions {
  now?: string;
  app?: RawEnv;
  identity?: RawEnv;
}

/** Every identity service wired by hand around the in-memory store, a fake clock and a fake SMS gateway. */
export function createIdentityHarness(options: HarnessOptions = {}): IdentityHarness {
  const clock = new FakeClock(options.now ?? TEST_NOW);
  const store = new InMemoryIdentityStore(() => clock.now());
  const sms = new InMemorySmsAdapter();
  const captcha = new RecordingCaptchaVerifier();
  const appConfig = makeAppConfig(options.app);
  const config = makeIdentityConfig(options.identity);
  const tokens = new TokenService(appConfig, clock);
  const sessions = new SessionService(store, tokens, clock);
  const devices = new DevicesService(store, clock);
  return {
    clock,
    store,
    sms,
    captcha,
    appConfig,
    config,
    tokens,
    sessions,
    devices,
    auth: new AuthService(store, sessions, devices, sms, captcha, clock, appConfig, config),
    profiles: new ProfileService(store, clock, config),
    children: new ChildrenService(store, clock),
    deletions: new AccountDeletionService(store, clock, config),
    adminAuth: new AdminAuthService(store, tokens, clock, appConfig, config),
    adminUsers: new AdminUsersService(store, clock),
    adminStaff: new AdminStaffService(store, clock, config),
    port: new IdentityPortService(store),
  };
}

export const ANDROID_DEVICE = {
  platform: 'android' as const,
  model: 'Pixel 8',
  appVersion: '1.0.0',
  fingerprint: 'install-fingerprint-0001',
};

/** Requests a code and verifies it with the code captured from the fake SMS gateway. */
export async function loginMember(
  harness: IdentityHarness,
  phone: string = TEST_PHONE,
  device: LoginDeviceInfo = ANDROID_DEVICE,
): ReturnType<AuthService['verifyOtp']> {
  await harness.auth.requestOtp({ phone, ip: TEST_IP });
  return harness.auth.verifyOtp({ phone, code: harness.sms.lastCode(phone), device });
}

export { captureAsyncError, captureError } from './errors';
