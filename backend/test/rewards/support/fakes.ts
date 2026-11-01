import type { Reward, ValidatorDevice, Voucher } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { type ScryptParams, hashPassword, sha256Hex } from '../../../src/common/auth/crypto';
import type { AppConfig } from '../../../src/common/config';
import type { AdminAuditPort, AuditEntry } from '../../../src/common/contracts/admin';
import {
  type ActiveRuleSet,
  type ClubLedgerPort,
  type CreditPointsInput,
  DEFAULT_LOYALTY_RULES,
  type HoldPointsInput,
  type LedgerEntry,
  type PointsBalance,
  type PointsDailyStats,
  type ReversePointsInput,
  type SpendPointsInput,
} from '../../../src/common/contracts/club';
import type {
  ContentPort,
  TenantDisplaySummary,
  TenantSummary,
} from '../../../src/common/contracts/content';
import type { OutboxEventPayloads, OutboxEventType } from '../../../src/common/contracts/events';
import type { ParkingPort, ParkingSessionSummary } from '../../../src/common/contracts/parking';
import type { Tx } from '../../../src/common/contracts/shared';
import { DomainError } from '../../../src/common/errors/domain-error';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import type { OutboxEventInput } from '../../../src/common/outbox/outbox.types';
import type { PrismaService } from '../../../src/common/prisma/prisma.service';
import { FakeClock } from '../../../src/common/time/clock';
import {
  DEFAULT_REWARDS_CONFIG,
  type RewardsConfig,
} from '../../../src/modules/rewards/rewards.config';
import { AdminVouchersService } from '../../../src/modules/rewards/services/admin-vouchers.service';
import { RedemptionService } from '../../../src/modules/rewards/services/redemption.service';
import { RewardsCatalogueService } from '../../../src/modules/rewards/services/rewards-catalogue.service';
import { ValidatorDevicesService } from '../../../src/modules/rewards/services/validator-devices.service';
import { ValidatorService } from '../../../src/modules/rewards/services/validator.service';
import { VoucherService } from '../../../src/modules/rewards/services/voucher.service';
import { InMemoryRewardsRepository, type Transactional } from './in-memory-rewards.repository';

/** Fast scrypt parameters for test PIN hashes (verifyPassword reads them from the PHC string). */
export const FAST_SCRYPT: ScryptParams = { N: 1024, r: 8, p: 1, keyLength: 64, saltLength: 16 };

export const TEST_VOUCHER_PEPPER = 'test-voucher-pepper-0123456789';

/** Marker object passed as the open transaction by the fake Prisma client. */
export const FAKE_TX = Object.freeze({ fakeTx: true }) as unknown as Tx;

/**
 * Stand-in for PrismaService: `withTx` snapshots every participant and restores it when the
 * callback throws, so services can be tested for all-or-nothing behaviour.
 */
export class FakeRewardsPrisma {
  transactions = 0;
  rollbacks = 0;

  constructor(private readonly participants: Transactional[]) {}

  async withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const snapshots = this.participants.map((participant) => participant.snapshot());
    this.transactions += 1;
    try {
      return await fn(FAKE_TX);
    } catch (error) {
      this.participants.forEach((participant, index) => participant.restore(snapshots[index]));
      this.rollbacks += 1;
      throw error;
    }
  }

  runInTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.withTx(fn);
  }

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}

export class FakeOutbox implements Transactional {
  events: OutboxEventInput[] = [];
  readonly clients: Tx[] = [];

  async publish(tx: Tx, event: OutboxEventInput): Promise<string> {
    this.clients.push(tx);
    this.events.push(structuredClone(event));
    return uuidv7();
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }

  ofType<T extends OutboxEventType>(
    type: T,
  ): Array<OutboxEventInput & { payload: OutboxEventPayloads[T] }> {
    return this.events.filter((event) => event.type === type) as Array<
      OutboxEventInput & { payload: OutboxEventPayloads[T] }
    >;
  }

  snapshot(): unknown {
    return structuredClone(this.events);
  }

  restore(snapshot: unknown): void {
    this.events = structuredClone(snapshot as OutboxEventInput[]);
  }

  asService(): OutboxService {
    return this as unknown as OutboxService;
  }
}

interface LedgerState {
  balances: Map<string, number>;
  entries: Map<string, LedgerEntry>;
}

/** Club ledger fake: available balance per user, idempotent by key, spend/refund rows. */
export class FakeLedger implements ClubLedgerPort, Transactional {
  private state: LedgerState = { balances: new Map(), entries: new Map() };
  failGetBalance = false;
  readonly spendCalls: Array<{ input: SpendPointsInput; tx: Tx | undefined }> = [];
  readonly reverseCalls: Array<{ input: ReversePointsInput; tx: Tx | undefined }> = [];
  /** Shared with the in-memory repository by RewardsWorld to assert the lock order. */
  callLog: string[] = [];

  constructor(private readonly now: () => Date) {}

  setBalance(userId: string, available: number): void {
    this.state.balances.set(userId, available);
  }

  balanceOf(userId: string): number | undefined {
    return this.state.balances.get(userId);
  }

  get entries(): LedgerEntry[] {
    return [...this.state.entries.values()];
  }

  snapshot(): unknown {
    return structuredClone(this.state);
  }

  restore(snapshot: unknown): void {
    this.state = structuredClone(snapshot as LedgerState);
  }

  async getBalance(userId: string): Promise<PointsBalance | null> {
    if (this.failGetBalance) {
      throw new Error('ledger unavailable');
    }
    const available = this.state.balances.get(userId);
    if (available === undefined) {
      return null;
    }
    return {
      accountId: `acc-${userId}`,
      userId,
      available,
      pending: 0,
      lifetimeEarned: Math.max(available, 0),
      newcomerLockUntil: null,
      spendBlockedBy: available < 0 ? 'negative_balance' : null,
    };
  }

  async getEntry(txId: string): Promise<LedgerEntry | null> {
    return this.state.entries.get(txId) ?? null;
  }

  async getActiveRules(): Promise<ActiveRuleSet> {
    return { id: 'rules-1', version: 1, activeFrom: new Date(0), rules: DEFAULT_LOYALTY_RULES };
  }

  private byKey(key: string): LedgerEntry | undefined {
    return [...this.state.entries.values()].find((entry) => entry.idempotencyKey === key);
  }

  private write(entry: Omit<LedgerEntry, 'id' | 'accountId' | 'createdAt'>): LedgerEntry {
    const row: LedgerEntry = {
      ...entry,
      id: uuidv7(),
      accountId: `acc-${entry.userId}`,
      createdAt: this.now(),
    };
    this.state.entries.set(row.id, row);
    return row;
  }

  async credit(input: CreditPointsInput): Promise<LedgerEntry> {
    const existing = this.byKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    this.state.balances.set(
      input.userId,
      (this.state.balances.get(input.userId) ?? 0) + input.amount,
    );
    return this.write({
      userId: input.userId,
      type: input.type ?? 'earn',
      state: 'available',
      amount: input.amount,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey,
      availableAt: this.now(),
      expiresAt: input.expiresAt ?? null,
      reason: input.reason ?? null,
      createdById: input.createdById ?? null,
    });
  }

  async hold(input: HoldPointsInput): Promise<LedgerEntry> {
    return this.credit(input);
  }

  async release(txId: string): Promise<LedgerEntry> {
    const entry = this.state.entries.get(txId);
    if (!entry) {
      throw new DomainError('PC_POINTS_TX_NOT_FOUND', 'Ledger entry not found', { status: 404 });
    }
    return entry;
  }

  async spend(input: SpendPointsInput, tx?: Tx): Promise<LedgerEntry> {
    this.spendCalls.push({ input, tx });
    this.callLog.push('ledger.spend');
    const existing = this.byKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const available = this.state.balances.get(input.userId) ?? 0;
    if (available < input.amount) {
      throw new DomainError('PC_POINTS_INSUFFICIENT', 'Not enough points', {
        status: 422,
        details: { available, required: input.amount },
      });
    }
    this.state.balances.set(input.userId, available - input.amount);
    return this.write({
      userId: input.userId,
      type: 'spend',
      state: 'spent',
      amount: -input.amount,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey,
      availableAt: null,
      expiresAt: null,
      reason: input.reason ?? null,
      createdById: input.createdById ?? null,
    });
  }

  async reverse(input: ReversePointsInput, tx?: Tx): Promise<LedgerEntry> {
    this.reverseCalls.push({ input, tx });
    this.callLog.push('ledger.reverse');
    const existing = this.byKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const original = this.state.entries.get(input.txId);
    if (!original) {
      throw new DomainError('PC_POINTS_TX_NOT_FOUND', 'Ledger entry not found', { status: 404 });
    }
    const amount = -original.amount;
    this.state.balances.set(
      original.userId,
      (this.state.balances.get(original.userId) ?? 0) + amount,
    );
    return this.write({
      userId: original.userId,
      type: original.type === 'spend' ? 'refund' : 'reverse',
      state: 'available',
      amount,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      idempotencyKey: input.idempotencyKey,
      availableAt: this.now(),
      expiresAt: null,
      reason: input.reason,
      createdById: input.createdById ?? null,
    });
  }

  async getDailyStats(): Promise<PointsDailyStats> {
    return { earned: 0, spent: 0, expired: 0, reversed: 0 };
  }
}

export function tenantSummary(overrides: Partial<TenantSummary> = {}): TenantSummary {
  return {
    id: uuidv7(),
    slug: 'aroma-kava',
    name: 'Aroma Kava',
    category: 'coffee',
    floor: 1,
    logoKey: null,
    participates: true,
    ratePercentOverride: null,
    excludedFromProgram: false,
    status: 'active',
    ...overrides,
  };
}

/** Logo base URL the content fake resolves `logoUrl` with (content's own logo base). */
export const FAKE_CONTENT_LOGO_BASE = 'https://content.test/logos';

/**
 * Content port fake: tenant lookups only; `fail` simulates the stub module (501),
 * `failDisplay` only the display lookup (so callers fall back to the batch summaries).
 */
export class FakeContent implements ContentPort {
  readonly tenants = new Map<string, TenantSummary>();
  fail = false;
  failDisplay = false;

  add(tenant: TenantSummary): TenantSummary {
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  private guard(): void {
    if (this.fail) {
      throw new DomainError('PC_COMMON_NOT_IMPLEMENTED', 'content is a stub', { status: 501 });
    }
  }

  async getTenant(tenantId: string): Promise<TenantSummary | null> {
    this.guard();
    return this.tenants.get(tenantId) ?? null;
  }

  async getTenantSummaryById(tenantId: string): Promise<TenantDisplaySummary | null> {
    this.guard();
    if (this.failDisplay) {
      throw new Error('display lookup unavailable');
    }
    const tenant = this.tenants.get(tenantId);
    return tenant
      ? {
          ...tenant,
          logoUrl: tenant.logoKey ? `${FAKE_CONTENT_LOGO_BASE}/${tenant.logoKey}` : null,
          locationText: tenant.floor === null ? null : `${tenant.floor} поверх`,
          mapImageUrl: null,
          isOpenNow: true,
        }
      : null;
  }

  async getTenants(tenantIds: readonly string[]): Promise<TenantSummary[]> {
    this.guard();
    return tenantIds.map((id) => this.tenants.get(id)).filter((t): t is TenantSummary => !!t);
  }

  findTenantByFiscalNumber(): never {
    throw new Error('not used by rewards');
  }

  isExcluded(): never {
    throw new Error('not used by rewards');
  }

  getTenantRule(): never {
    throw new Error('not used by rewards');
  }

  recordSeenFiscalNumber(): never {
    throw new Error('not used by rewards');
  }
}

/** Parking port fake: the current session of a member (enrichment of parking_hour vouchers). */
export class FakeParking implements ParkingPort {
  session: ParkingSessionSummary | null = null;
  fail = false;

  async getSessionForUser(): Promise<ParkingSessionSummary | null> {
    if (this.fail) {
      throw new DomainError('PC_COMMON_NOT_IMPLEMENTED', 'parking is a stub', { status: 501 });
    }
    return this.session;
  }

  getSession(): never {
    throw new Error('not used by rewards');
  }

  quote(): never {
    throw new Error('not used by rewards');
  }

  getActiveTariff(): never {
    throw new Error('not used by rewards');
  }

  getDailyStats(): never {
    throw new Error('not used by rewards');
  }
}

export class FakeAudit implements AdminAuditPort, Transactional {
  entries: Array<{ entry: AuditEntry; tx: Tx | undefined }> = [];

  async audit(entry: AuditEntry, tx?: Tx): Promise<string> {
    this.entries.push({ entry: structuredClone(entry), tx });
    return uuidv7();
  }

  actions(): string[] {
    return this.entries.map(({ entry }) => entry.action);
  }

  snapshot(): unknown {
    return [...this.entries];
  }

  restore(snapshot: unknown): void {
    this.entries = [...(snapshot as FakeAudit['entries'])];
  }
}

export interface RewardsWorldOptions {
  now?: string;
  config?: Partial<RewardsConfig>;
  /** S3_PUBLIC_BASE_URL (unset by default, so image URLs are null). */
  publicBaseUrl?: string;
}

/** Every service of the module wired on fakes, plus seeding helpers. */
export class RewardsWorld {
  readonly clock: FakeClock;
  readonly repo: InMemoryRewardsRepository;
  readonly outbox = new FakeOutbox();
  readonly ledger: FakeLedger;
  readonly content = new FakeContent();
  readonly parking = new FakeParking();
  readonly audit = new FakeAudit();
  readonly prisma: FakeRewardsPrisma;
  readonly config: RewardsConfig;
  readonly appConfig: AppConfig;

  readonly vouchers: VoucherService;
  readonly redemptions: RedemptionService;
  readonly catalogue: RewardsCatalogueService;
  readonly validator: ValidatorService;
  readonly devices: ValidatorDevicesService;
  readonly adminVouchers: AdminVouchersService;

  /** Lock and ledger calls in order (shared by the repository and the ledger fakes). */
  readonly callLog: string[] = [];

  constructor(options: RewardsWorldOptions = {}) {
    this.clock = new FakeClock(options.now ?? '2026-11-01T10:00:00.000Z');
    const now = (): Date => this.clock.now();
    this.repo = new InMemoryRewardsRepository(now);
    this.ledger = new FakeLedger(now);
    this.repo.callLog = this.callLog;
    this.ledger.callLog = this.callLog;
    this.prisma = new FakeRewardsPrisma([this.repo, this.outbox, this.ledger, this.audit]);
    this.config = { ...DEFAULT_REWARDS_CONFIG, ...options.config };
    this.appConfig = {
      VOUCHER_PEPPER: TEST_VOUCHER_PEPPER,
      ...(options.publicBaseUrl !== undefined ? { S3_PUBLIC_BASE_URL: options.publicBaseUrl } : {}),
    } as AppConfig;

    const prisma = this.prisma.asPrisma();
    const outbox = this.outbox.asService();
    this.vouchers = new VoucherService(
      prisma,
      this.repo,
      outbox,
      this.clock,
      this.ledger,
      this.appConfig,
      this.config,
      this.content,
    );
    this.redemptions = new RedemptionService(
      prisma,
      this.repo,
      this.vouchers,
      outbox,
      this.clock,
      this.ledger,
      this.content,
      this.parking,
      this.config,
    );
    this.catalogue = new RewardsCatalogueService(
      prisma,
      this.repo,
      this.clock,
      this.ledger,
      this.content,
      this.audit,
      this.appConfig,
    );
    this.validator = new ValidatorService(
      prisma,
      this.repo,
      outbox,
      this.clock,
      this.vouchers,
      this.appConfig,
      this.config,
      this.audit,
    );
    this.devices = new ValidatorDevicesService(
      prisma,
      this.repo,
      this.clock,
      this.content,
      this.audit,
    );
    this.adminVouchers = new AdminVouchersService(prisma, this.vouchers, this.audit);
  }

  now(): Date {
    return this.clock.now();
  }

  seedReward(overrides: Partial<Reward> = {}): Reward {
    const now = this.now();
    const reward: Reward = {
      id: uuidv7(),
      title: 'Кава з собою',
      description: null,
      costPoints: 60,
      kind: 'partner',
      tenantId: null,
      stock: null,
      perUserLimit: null,
      active: true,
      validFrom: null,
      validTo: null,
      imageKey: null,
      terms: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.repo.putReward(reward);
    return reward;
  }

  seedVoucher(overrides: Partial<Voucher> = {}): Voucher {
    const now = this.now();
    const voucher: Voucher = {
      id: uuidv7(),
      userId: 'user-1',
      kind: 'reward',
      title: 'Кава з собою',
      subtitle: null,
      tenantId: null,
      code: null,
      tokenHash: null,
      status: 'issued',
      activatedAt: null,
      activationExpiresAt: null,
      redeemedAt: null,
      redeemedByDeviceId: null,
      redeemedByTenantId: null,
      expiresAt: null,
      sourceType: 'admin',
      sourceId: uuidv7(),
      meta: {},
      imageKey: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.repo.putVoucher(voucher);
    return voucher;
  }

  async seedDevice(
    options: {
      key?: string;
      pin?: string;
      tenantId?: string | null;
      overrides?: Partial<ValidatorDevice>;
    } = {},
  ): Promise<{ device: ValidatorDevice; key: string; pin: string }> {
    const key = options.key ?? `device-key-${uuidv7()}`;
    const pin = options.pin ?? '482915';
    const now = this.now();
    const device: ValidatorDevice = {
      id: uuidv7(),
      tenantId: options.tenantId ?? null,
      name: 'Aroma Kava, каса 1',
      pinHash: await hashPassword(pin, FAST_SCRYPT),
      deviceKeyHash: sha256Hex(key),
      active: true,
      lastSeenAt: null,
      revokedAt: null,
      failedPinAttempts: 0,
      pinLockedUntil: null,
      createdAt: now,
      updatedAt: now,
      ...options.overrides,
    };
    this.repo.putDevice(device);
    return { device, key, pin };
  }
}

/** Deterministic code generator yielding the given codes in order (then repeating the last). */
export function sequenceCodes(...codes: string[]): (length: number, alphabet: string) => string {
  let index = 0;
  return () => {
    const code = codes[Math.min(index, codes.length - 1)] ?? 'AAAAAA';
    index += 1;
    return code;
  };
}
