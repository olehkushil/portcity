import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AdminAccess } from '../contracts/identity';
import { DomainError } from '../errors/domain-error';
import { CommonErrors } from '../errors/error-codes';
import { Clock } from '../time/clock';
import type { AuthenticatedUser } from './auth.types';

/** Looks up the current state of a back-office account (IDENTITY_PORT.getAdminAccess). */
export type AdminAccessResolver = (adminId: string) => Promise<AdminAccess | null>;

interface CacheEntry {
  value: AdminAccess | null;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 1000;

/**
 * Bridge between the shared AdminGuard and the identity module, which owns `admin_users`.
 *
 * Admin access tokens are stateless (ADMIN_ACCESS_TTL_SECONDS, 8 h by default), so without a
 * check a deactivated admin or one whose role changed would keep access until the token expires.
 * The common layer cannot import a domain module (identity depends on it), so identity registers
 * a resolver in `onModuleInit` (`useResolver`) and AdminGuard calls `assertActive()` on every
 * admin request. Answers are cached per admin for ADMIN_ACCESS_CACHE_SECONDS (30 s by default);
 * identity calls `invalidate(adminId)` when it changes an account, so the replica that made the
 * change applies it at once and other replicas within the cache window.
 *
 * Without a resolver (unit tests that do not boot identity) the check is skipped. e2e tests
 * disable it by default because their admin tokens belong to no stored account
 * (test/utils/app-factory.ts, option `adminAccessCheck`).
 */
@Injectable()
export class AdminAccessGate {
  private readonly logger = new Logger(AdminAccessGate.name);
  private resolver: AdminAccessResolver | null = null;
  private enabled = true;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  useResolver(resolver: AdminAccessResolver): void {
    this.resolver = resolver;
    this.cache.clear();
  }

  /** Test hook: skip the check entirely (tokens of admins that do not exist in storage). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.cache.clear();
  }

  /** True when a resolver is registered and the check is enabled. */
  get active(): boolean {
    return this.enabled && this.resolver !== null;
  }

  /** Drops the cached answer for one admin (after an update) or for everybody. */
  invalidate(adminId?: string): void {
    if (adminId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(adminId);
    }
  }

  /**
   * Throws 403 PC_ADMIN_INACTIVE for unknown or deactivated accounts and 401
   * PC_AUTH_TOKEN_INVALID when the role in the token no longer matches the stored role.
   */
  async assertActive(user: AuthenticatedUser): Promise<void> {
    if (!this.active || user.type !== 'admin') {
      return;
    }
    const access = await this.lookup(user.id);
    if (!access || !access.active) {
      throw new DomainError('PC_ADMIN_INACTIVE', 'This admin account is deactivated', {
        status: 403,
        title: 'Admin account is deactivated',
      });
    }
    if (!user.roles.includes(access.role)) {
      throw new DomainError(
        CommonErrors.PC_AUTH_TOKEN_INVALID,
        'The admin role changed since login; log in again',
      );
    }
  }

  private async lookup(adminId: string): Promise<AdminAccess | null> {
    const ttlMs = this.config.ADMIN_ACCESS_CACHE_SECONDS * 1000;
    const now = this.clock.nowMs();
    const cached = this.cache.get(adminId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const resolver = this.resolver;
    if (!resolver) {
      return null;
    }
    let value: AdminAccess | null;
    try {
      value = await resolver(adminId);
    } catch (error) {
      this.logger.error(
        `Admin access lookup failed for ${adminId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new DomainError(
        CommonErrors.PC_COMMON_SERVICE_UNAVAILABLE,
        'Cannot verify the admin account right now',
        { cause: error },
      );
    }
    if (ttlMs > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        this.cache.clear();
      }
      this.cache.set(adminId, { value, expiresAt: now + ttlMs });
    }
    return value;
  }
}
