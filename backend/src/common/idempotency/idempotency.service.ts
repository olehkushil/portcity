import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config';
import { isUniqueViolation } from '../prisma/prisma.errors';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../time/clock';
import {
  DEFAULT_IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_CONFIG,
  type IdempotencyConfig,
} from './idempotency.config';

export type BeginResult =
  | {
      kind: 'proceed';
      /**
       * `createdAt` written by this claim: the ownership token passed back to `complete` and
       * `abandon`, so a request whose key was taken over cannot overwrite the new owner's row.
       * Optional for test doubles that implement the protocol without it.
       */
      claimedAt?: Date;
      /** True when an abandoned in-progress row (older than the lease) was taken over. */
      tookOver?: boolean;
    }
  | { kind: 'replay'; status: number; response: unknown }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

/**
 * Persistence for the Idempotency-Key protocol (table idempotency_keys, pk (scope, key)):
 * - `begin` claims the key or tells the caller to replay / reject; an in-progress row older
 *   than the lease (IDEMPOTENCY_LEASE_SECONDS) belongs to a crashed request and is taken over,
 * - `complete` stores the successful response (only on the row this request still owns),
 * - `abandon` releases the key after a handler failure so the client may retry,
 * - `purgeExpired` is run hourly by the maintenance queue.
 */
@Injectable()
export class IdempotencyService {
  private readonly leaseSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(IDEMPOTENCY_CONFIG) idempotencyConfig?: IdempotencyConfig,
  ) {
    this.leaseSeconds =
      idempotencyConfig?.IDEMPOTENCY_LEASE_SECONDS ?? DEFAULT_IDEMPOTENCY_LEASE_SECONDS;
  }

  get ttlMs(): number {
    return this.config.IDEMPOTENCY_TTL_HOURS * 3_600_000;
  }

  /** In-progress rows older than this were left behind by a crashed request. */
  get leaseMs(): number {
    return this.leaseSeconds * 1000;
  }

  async begin(scope: string, key: string, requestHash: string): Promise<BeginResult> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });

    if (existing && existing.expiresAt.getTime() > now.getTime()) {
      if (existing.requestHash !== requestHash) {
        return { kind: 'mismatch' };
      }
      if (existing.status !== null) {
        return { kind: 'replay', status: existing.status, response: existing.response };
      }
      if (existing.createdAt.getTime() + this.leaseMs > now.getTime()) {
        return { kind: 'in_progress' };
      }
      // Lease expired: the request that claimed the key crashed (its transaction rolled back)
      // or the store of its response kept failing. Take the row over atomically: the
      // `createdAt` match makes a concurrent taker (or a late original) lose.
      const taken = await this.prisma.idempotencyKey.updateMany({
        where: { scope, key, status: null, createdAt: existing.createdAt },
        data: { createdAt: now, expiresAt },
      });
      return taken.count === 1
        ? { kind: 'proceed', claimedAt: now, tookOver: true }
        : { kind: 'in_progress' };
    }

    if (existing) {
      // Expired row: take it over atomically; a concurrent taker makes this a no-op.
      const taken = await this.prisma.idempotencyKey.updateMany({
        where: { scope, key, expiresAt: { lte: now } },
        data: { requestHash, status: null, response: Prisma.DbNull, createdAt: now, expiresAt },
      });
      return taken.count === 1 ? { kind: 'proceed', claimedAt: now } : { kind: 'in_progress' };
    }

    try {
      await this.prisma.idempotencyKey.create({
        data: { scope, key, requestHash, createdAt: now, expiresAt },
      });
      return { kind: 'proceed', claimedAt: now };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { kind: 'in_progress' };
      }
      throw error;
    }
  }

  /**
   * Stores the response on the in-progress row this request claimed. Returns false when there
   * is nothing to store into: the response is already stored (a retried store whose first
   * attempt did commit) or the row was taken over after the lease.
   */
  async complete(
    scope: string,
    key: string,
    status: number,
    response: unknown,
    claimedAt?: Date,
  ): Promise<boolean> {
    const result = await this.prisma.idempotencyKey.updateMany({
      where: { scope, key, status: null, ...(claimedAt ? { createdAt: claimedAt } : {}) },
      data: { status, response: toJsonValue(response) },
    });
    return result.count > 0;
  }

  /** Releases the in-progress row this request claimed; stored responses are never deleted. */
  async abandon(scope: string, key: string, claimedAt?: Date): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: { scope, key, status: null, ...(claimedAt ? { createdAt: claimedAt } : {}) },
    });
  }

  async purgeExpired(now: Date = this.clock.now()): Promise<number> {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}

/** Response bodies are JSON-serialised the same way Express would send them. */
export function toJsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) {
    return Prisma.JsonNull;
  }
  const serialised = JSON.stringify(value);
  if (serialised === undefined) {
    return Prisma.JsonNull;
  }
  return JSON.parse(serialised) as Prisma.InputJsonValue;
}
