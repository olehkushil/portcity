import { Injectable } from '@nestjs/common';
import type { FeatureFlagView, FeatureFlagsPort } from '../contracts/admin';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../time/clock';

/** How long a flag value is served from memory before the table is read again. */
export const FEATURE_FLAG_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  value: FeatureFlagView | null;
  expiresAt: number;
}

/**
 * Read side of feature flags (table feature_flags in base.prisma). Implements FEATURE_FLAGS_PORT.
 * Writes belong to the admin module, which calls `invalidate(key)` after each change
 * (other API replicas pick the change up within FEATURE_FLAG_CACHE_TTL_MS).
 */
@Injectable()
export class FeatureFlagsService implements FeatureFlagsPort {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async get(key: string): Promise<FeatureFlagView | null> {
    const now = this.clock.nowMs();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    const value: FeatureFlagView | null = row
      ? {
          key: row.key,
          enabled: row.enabled,
          payload: isPlainObject(row.payload) ? row.payload : null,
          updatedAt: row.updatedAt,
        }
      : null;
    this.cache.set(key, { value, expiresAt: now + FEATURE_FLAG_CACHE_TTL_MS });
    return value;
  }

  async isEnabled(key: string, fallback = false): Promise<boolean> {
    const flag = await this.get(key);
    return flag ? flag.enabled : fallback;
  }

  /** Drops cached values (one key or all) so the next read hits the database. */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(key);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
