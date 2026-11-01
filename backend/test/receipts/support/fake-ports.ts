import { uuidv7 } from 'uuidv7';
import type {
  AdminAuditPort,
  AuditEntry,
  FeatureFlagView,
  FeatureFlagsPort,
} from '../../../src/common/contracts/admin';
import {
  type ActiveRuleSet,
  type ClubLedgerPort,
  type CreditPointsInput,
  DEFAULT_LOYALTY_RULES,
  type HoldPointsInput,
  type LedgerEntry,
  type LoyaltyRules,
  type PointsBalance,
  type PointsDailyStats,
  type ReversePointsInput,
} from '../../../src/common/contracts/club';
import type { IdentityPort, UserSummary } from '../../../src/common/contracts/identity';
import {
  type TaxReceiptCheckInput,
  type TaxReceiptCheckResult,
  TaxReceiptVerifierPort,
} from '../../../src/modules/receipts/services/tax-receipt-verifier';
import type {
  ContentPort,
  EffectiveTenantRule,
  FiscalNumberLookup,
  FiscalNumberStatus,
  RecordSeenFiscalNumberOptions,
  TenantDisplaySummary,
  TenantSummary,
} from '../../../src/common/contracts/content';
import type { OutboxEventInput } from '../../../src/common/outbox/outbox.types';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import type { Clock } from '../../../src/common/time/clock';
import type { Snapshotable } from './fake-tx';

/** Records published outbox events; rolled back with the fake transaction. */
export class FakeOutbox implements Snapshotable {
  events: OutboxEventInput[] = [];

  snapshot(): unknown {
    return [...this.events];
  }

  restore(snapshot: unknown): void {
    this.events = [...(snapshot as OutboxEventInput[])];
  }

  async publish(_tx: unknown, event: OutboxEventInput): Promise<string> {
    this.events.push(event);
    return uuidv7();
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }

  ofType(type: string): OutboxEventInput[] {
    return this.events.filter((event) => event.type === type);
  }

  /** Typed escape hatch: OutboxService has private members, the services only call publish(). */
  asService(): OutboxService {
    return this as unknown as OutboxService;
  }
}

type LedgerMethod = 'getActiveRules' | 'credit' | 'hold' | 'getBalance' | 'getEntry' | 'reverse';

/** CLUB_LEDGER_PORT fake: idempotent by key, joins the fake transaction, injectable failures. */
export class FakeLedger implements ClubLedgerPort, Snapshotable {
  entries: LedgerEntry[] = [];
  rules: LoyaltyRules = { ...DEFAULT_LOYALTY_RULES };
  readonly calls: Array<{ method: LedgerMethod; key?: string }> = [];
  /** Every credit/hold input as received (display data included). */
  readonly inputs: CreditPointsInput[] = [];
  private readonly failures = new Map<LedgerMethod, Error[]>();

  constructor(private readonly clock: Clock) {}

  snapshot(): unknown {
    return this.entries.map((entry) => ({ ...entry }));
  }

  restore(snapshot: unknown): void {
    this.entries = (snapshot as LedgerEntry[]).map((entry) => ({ ...entry }));
  }

  /** The next `times` calls of `method` throw `error`. */
  failNext(
    method: LedgerMethod,
    error: Error = new Error(`${method} unavailable`),
    times = 1,
  ): void {
    const queue = this.failures.get(method) ?? [];
    for (let index = 0; index < times; index += 1) {
      queue.push(error);
    }
    this.failures.set(method, queue);
  }

  private maybeFail(method: LedgerMethod): void {
    const queue = this.failures.get(method);
    const error = queue?.shift();
    if (error) {
      throw error;
    }
  }

  async getBalance(userId: string): Promise<PointsBalance | null> {
    this.calls.push({ method: 'getBalance' });
    this.maybeFail('getBalance');
    const own = this.entries.filter((entry) => entry.userId === userId);
    if (own.length === 0) {
      return null;
    }
    const sum = (state: LedgerEntry['state']): number =>
      own
        .filter((entry) => entry.state === state)
        .reduce((total, entry) => total + entry.amount, 0);
    return {
      accountId: `account-${userId}`,
      userId,
      available: sum('available'),
      pending: sum('pending'),
      lifetimeEarned: sum('available') + sum('pending'),
      newcomerLockUntil: null,
      spendBlockedBy: null,
    };
  }

  async getEntry(txId: string): Promise<LedgerEntry | null> {
    this.calls.push({ method: 'getEntry' });
    this.maybeFail('getEntry');
    return this.entries.find((entry) => entry.id === txId) ?? null;
  }

  async getActiveRules(at?: Date): Promise<ActiveRuleSet> {
    this.calls.push({ method: 'getActiveRules' });
    this.maybeFail('getActiveRules');
    return { id: 'rules-v1', version: 1, activeFrom: at ?? this.clock.now(), rules: this.rules };
  }

  private write(
    input: CreditPointsInput,
    state: 'available' | 'pending',
    availableAt: Date,
  ): LedgerEntry {
    const existing = this.entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const entry: LedgerEntry = {
      id: uuidv7(),
      accountId: `account-${input.userId}`,
      userId: input.userId,
      type: input.type ?? 'earn',
      state,
      amount: input.amount,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey,
      availableAt,
      expiresAt: input.expiresAt ?? null,
      reason: input.reason ?? null,
      createdById: input.createdById ?? null,
      createdAt: this.clock.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  async credit(input: CreditPointsInput): Promise<LedgerEntry> {
    this.calls.push({ method: 'credit', key: input.idempotencyKey });
    this.inputs.push(input);
    this.maybeFail('credit');
    return this.write(input, 'available', this.clock.now());
  }

  async hold(input: HoldPointsInput): Promise<LedgerEntry> {
    this.calls.push({ method: 'hold', key: input.idempotencyKey });
    this.inputs.push(input);
    this.maybeFail('hold');
    return this.write(input, 'pending', input.availableAt);
  }

  async release(): Promise<LedgerEntry> {
    throw new Error('not used by receipts');
  }

  async spend(): Promise<LedgerEntry> {
    throw new Error('not used by receipts');
  }

  /** Pending credit -> cancelled (the only reversal receipts performs: failed verification). */
  async reverse(input: ReversePointsInput): Promise<LedgerEntry> {
    this.calls.push({ method: 'reverse', key: input.idempotencyKey });
    this.maybeFail('reverse');
    const entry = this.entries.find((candidate) => candidate.id === input.txId);
    if (!entry) {
      throw new Error(`ledger entry ${input.txId} not found`);
    }
    if (entry.state === 'pending') {
      entry.state = 'cancelled';
      entry.reason = input.reason;
      return entry;
    }
    const existing = this.entries.find(
      (candidate) => candidate.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      return existing;
    }
    const compensation: LedgerEntry = {
      ...entry,
      id: uuidv7(),
      type: 'reverse',
      amount: -entry.amount,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      createdAt: this.clock.now(),
    };
    this.entries.push(compensation);
    return compensation;
  }

  async getDailyStats(): Promise<PointsDailyStats> {
    return { earned: 0, spent: 0, expired: 0, reversed: 0 };
  }

  countWrites(): number {
    return this.calls.filter((call) => call.method === 'credit' || call.method === 'hold').length;
  }
}

interface FiscalRow {
  fn: string;
  status: FiscalNumberStatus;
  tenantId: string | null;
  source: FiscalNumberLookup['source'];
  firstSeenAt: Date;
  /** Receipt passed to recordSeenFiscalNumber (tenant.fiscal_number_seen payload). */
  seenOnReceiptId?: string | null;
}

/** CONTENT_PORT fake: tenants, the fiscal-number whitelist and tenant rules. */
export class FakeContent implements ContentPort, Snapshotable {
  readonly tenants = new Map<string, TenantSummary>();
  readonly rules = new Map<string, EffectiveTenantRule>();
  private fiscal = new Map<string, FiscalRow>();
  failLookups = false;

  constructor(private readonly clock: Clock) {}

  snapshot(): unknown {
    return new Map([...this.fiscal].map(([key, row]) => [key, { ...row }]));
  }

  restore(snapshot: unknown): void {
    this.fiscal = new Map(
      [...(snapshot as Map<string, FiscalRow>)].map(([key, row]) => [key, { ...row }]),
    );
  }

  addTenant(overrides: Partial<TenantSummary> & Pick<TenantSummary, 'id' | 'name'>): TenantSummary {
    const tenant: TenantSummary = {
      slug: overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      category: 'fashion',
      floor: 1,
      logoKey: null,
      participates: true,
      ratePercentOverride: null,
      excludedFromProgram: false,
      status: 'active',
      ...overrides,
    };
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  addFiscalNumber(
    fn: string,
    tenantId: string | null,
    status: FiscalNumberStatus = 'active',
  ): void {
    this.fiscal.set(fn, { fn, status, tenantId, source: 'admin', firstSeenAt: this.clock.now() });
  }

  fiscalNumber(fn: string): FiscalRow | undefined {
    return this.fiscal.get(fn);
  }

  async getTenant(tenantId: string): Promise<TenantSummary | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async getTenantSummaryById(tenantId: string): Promise<TenantDisplaySummary | null> {
    const tenant = this.tenants.get(tenantId);
    return tenant
      ? { ...tenant, logoUrl: null, locationText: null, mapImageUrl: null, isOpenNow: true }
      : null;
  }

  async getTenants(tenantIds: readonly string[]): Promise<TenantSummary[]> {
    return tenantIds
      .map((id) => this.tenants.get(id))
      .filter((tenant): tenant is TenantSummary => tenant !== undefined);
  }

  private toLookup(row: FiscalRow): FiscalNumberLookup {
    return {
      fn: row.fn,
      status: row.status,
      source: row.source,
      tenantId: row.tenantId,
      tenant: row.tenantId ? (this.tenants.get(row.tenantId) ?? null) : null,
      firstSeenAt: row.firstSeenAt,
    };
  }

  async findTenantByFiscalNumber(fn: string): Promise<FiscalNumberLookup | null> {
    if (this.failLookups) {
      throw new Error('content unavailable');
    }
    const row = this.fiscal.get(fn);
    return row ? this.toLookup(row) : null;
  }

  async isExcluded(tenantId: string): Promise<boolean> {
    const tenant = this.tenants.get(tenantId);
    return (
      !tenant || tenant.excludedFromProgram || !tenant.participates || tenant.status === 'closed'
    );
  }

  async getTenantRule(tenantId: string): Promise<EffectiveTenantRule> {
    const rule = this.rules.get(tenantId);
    if (rule) {
      return rule;
    }
    const override = this.tenants.get(tenantId)?.ratePercentOverride ?? null;
    return {
      tenantId,
      ratePercent: override,
      minTotalKopecks: 0,
      dailyCapPoints: null,
      source: override === null ? 'none' : 'override',
    };
  }

  async recordSeenFiscalNumber(
    fn: string,
    _tx?: unknown,
    options?: RecordSeenFiscalNumberOptions,
  ): Promise<FiscalNumberLookup> {
    const existing = this.fiscal.get(fn);
    if (existing) {
      return this.toLookup(existing);
    }
    const row: FiscalRow = {
      fn,
      status: 'pending',
      tenantId: null,
      source: 'receipt',
      firstSeenAt: this.clock.now(),
      seenOnReceiptId: options?.receiptId ?? null,
    };
    this.fiscal.set(fn, row);
    return this.toLookup(row);
  }
}

/** ADMIN_AUDIT_PORT fake. */
export class FakeAudit implements AdminAuditPort, Snapshotable {
  entries: Array<AuditEntry & { inTx: boolean }> = [];

  snapshot(): unknown {
    return [...this.entries];
  }

  restore(snapshot: unknown): void {
    this.entries = [...(snapshot as Array<AuditEntry & { inTx: boolean }>)];
  }

  async audit(entry: AuditEntry, tx?: unknown): Promise<string> {
    this.entries.push({ ...entry, inTx: tx !== undefined });
    return uuidv7();
  }

  actions(): string[] {
    return this.entries.map((entry) => entry.action);
  }
}

/** IDENTITY_PORT fake: only getUser (account age for the verification hold). */
export class FakeIdentity {
  /** Registration time per member; members not listed are unknown (null). */
  readonly createdAt = new Map<string, Date>();
  failGetUser = false;

  async getUser(userId: string): Promise<UserSummary | null> {
    if (this.failGetUser) {
      throw new Error('identity unavailable');
    }
    const createdAt = this.createdAt.get(userId);
    return createdAt === undefined
      ? null
      : {
          id: userId,
          phone: '+380500000000',
          email: null,
          firstName: null,
          lastName: null,
          birthDate: null,
          status: 'active',
          memberCode: '000000000',
          profileCompletedAt: null,
          createdAt,
          deletedAt: null,
        };
  }

  /** Typed escape hatch: the receipts module only calls getUser. */
  asPort(): IdentityPort {
    return this as unknown as IdentityPort;
  }
}

/** TaxReceiptVerifierPort fake: scripted answers per receipt id, `unknown` otherwise. */
export class FakeTaxVerifier extends TaxReceiptVerifierPort {
  readonly answers = new Map<string, TaxReceiptCheckResult>();
  /** Answer for every receipt without a scripted one. */
  fallback: TaxReceiptCheckResult = { status: 'unknown' };
  readonly calls: TaxReceiptCheckInput[] = [];
  failNext = false;

  verify(input: TaxReceiptCheckInput): Promise<TaxReceiptCheckResult> {
    this.calls.push(input);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('checker unavailable'));
    }
    return Promise.resolve(this.answers.get(input.receiptId) ?? this.fallback);
  }
}

/** FEATURE_FLAGS_PORT fake. */
export class FakeFlags implements FeatureFlagsPort {
  readonly values = new Map<string, boolean>();

  async isEnabled(key: string, fallback = false): Promise<boolean> {
    return this.values.get(key) ?? fallback;
  }

  async get(key: string): Promise<FeatureFlagView | null> {
    const enabled = this.values.get(key);
    return enabled === undefined ? null : { key, enabled, payload: null, updatedAt: new Date(0) };
  }
}
