import { Prisma } from '@prisma/client';
import type { PrismaService, Tx } from '../../../common/prisma/prisma.service';

/**
 * In-memory stand-in for the Prisma client, covering the query subset the parking module and
 * the common layer (outbox, audit, feature flags, idempotency) use. It interprets `where`
 * filters (equals, in, not, lt/lte/gt/gte, null, AND/OR/NOT), `orderBy`, `take`, `skip`,
 * `cursor`, `select`, `increment`, unique violations (P2002) and missing rows (P2025).
 * Tests cast it: `fake.asPrisma()`.
 */
type Row = Record<string, unknown>;

interface ModelDefinition {
  /** Unique key sets; the first one is the primary key. */
  uniques: string[][];
  defaults?: (now: Date) => Row;
}

const OPERATORS = new Set([
  'equals',
  'not',
  'in',
  'notIn',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
]);

function isPlainObject(value: unknown): value is Row {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function equal(a: unknown, b: unknown): boolean {
  return comparable(a) === comparable(b);
}

function compare(a: unknown, b: unknown): number {
  const left = comparable(a);
  const right = comparable(b);
  if (left === right) {
    return 0;
  }
  if (left === null || left === undefined) {
    return 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return sortKey(left) < sortKey(right) ? -1 : 1;
}

function sortKey(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    // false sorts before true, like PostgreSQL.
    return value ? '1' : '0';
  }
  return JSON.stringify(value) ?? '';
}

function hasOperatorKeys(condition: Row): boolean {
  return Object.keys(condition).some((key) => OPERATORS.has(key));
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === null || condition === undefined) {
    return value === null || value === undefined;
  }
  if (!isPlainObject(condition)) {
    return equal(value, condition);
  }
  const insensitive = condition['mode'] === 'insensitive';
  const text = (input: unknown): string =>
    insensitive ? String(input).toLowerCase() : String(input);
  for (const [operator, operand] of Object.entries(condition)) {
    switch (operator) {
      case 'equals':
        if (!matchesCondition(value, operand === undefined ? null : operand)) {
          return false;
        }
        break;
      case 'not':
        if (operand === null || operand === undefined) {
          if (value === null || value === undefined) {
            return false;
          }
        } else if (matchesCondition(value, operand)) {
          return false;
        }
        break;
      case 'in':
        if (!(operand as unknown[]).some((item) => equal(value, item))) {
          return false;
        }
        break;
      case 'notIn':
        if ((operand as unknown[]).some((item) => equal(value, item))) {
          return false;
        }
        break;
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        if (value === null || value === undefined) {
          return false;
        }
        const result = compare(value, operand);
        if (
          (operator === 'lt' && !(result < 0)) ||
          (operator === 'lte' && !(result <= 0)) ||
          (operator === 'gt' && !(result > 0)) ||
          (operator === 'gte' && !(result >= 0))
        ) {
          return false;
        }
        break;
      }
      case 'contains':
        if (!text(value).includes(text(operand))) {
          return false;
        }
        break;
      case 'startsWith':
        if (!text(value).startsWith(text(operand))) {
          return false;
        }
        break;
      case 'endsWith':
        if (!text(value).endsWith(text(operand))) {
          return false;
        }
        break;
      case 'mode':
        break;
      default:
        throw new Error(`FakePrisma: unsupported filter operator "${operator}"`);
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) {
    return true;
  }
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) {
      continue;
    }
    if (key === 'AND') {
      const list = Array.isArray(condition) ? (condition as Row[]) : [condition as Row];
      if (!list.every((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }
    if (key === 'OR') {
      const list = condition as Row[];
      if (!list.some((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }
    if (key === 'NOT') {
      const list = Array.isArray(condition) ? (condition as Row[]) : [condition as Row];
      if (list.some((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }
    if (!(key in row) && isPlainObject(condition) && !hasOperatorKeys(condition)) {
      // Compound unique selector such as `scope_key: { scope, key }`.
      if (!matchesWhere(row, condition)) {
        return false;
      }
      continue;
    }
    if (!matchesCondition(row[key], condition)) {
      return false;
    }
  }
  return true;
}

type OrderBy = Record<string, unknown> | Array<Record<string, unknown>>;

function sortRows(rows: Row[], orderBy: OrderBy | undefined): Row[] {
  if (!orderBy) {
    return rows;
  }
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((clause) =>
    Object.entries(clause).map(([field, direction]) => ({
      field,
      desc: (isPlainObject(direction) ? direction['sort'] : direction) === 'desc' ? true : false,
    })),
  );
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const result = compare(a[clause.field], b[clause.field]);
      if (result !== 0) {
        return clause.desc ? -result : result;
      }
    }
    return 0;
  });
}

function pick(row: Row, select: Row | undefined): Row {
  if (!select) {
    return { ...row };
  }
  const result: Row = {};
  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) {
      result[key] = row[key];
    }
  }
  return result;
}

function uniqueViolation(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'fake',
    meta: { target },
  });
}

function notFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record not found', {
    code: 'P2025',
    clientVersion: 'fake',
  });
}

interface QueryArgs {
  where?: Row;
  orderBy?: OrderBy;
  take?: number;
  skip?: number;
  cursor?: Row;
  select?: Row;
  include?: Row;
  data?: Row;
  create?: Row;
  update?: Row;
  _sum?: Row;
  _count?: unknown;
}

export class FakeModel {
  readonly rows: Row[] = [];

  constructor(
    readonly name: string,
    private readonly definition: ModelDefinition,
    private readonly now: () => Date,
  ) {}

  seed(...rows: Row[]): this {
    for (const row of rows) {
      this.rows.push(this.withDefaults(row));
    }
    return this;
  }

  clear(): void {
    this.rows.length = 0;
  }

  async findMany(args: QueryArgs = {}): Promise<Row[]> {
    return this.query(args).map((row) => pick(row, args.select));
  }

  async findFirst(args: QueryArgs = {}): Promise<Row | null> {
    const row = this.query(args)[0];
    return row ? pick(row, args.select) : null;
  }

  async findFirstOrThrow(args: QueryArgs = {}): Promise<Row> {
    const row = await this.findFirst(args);
    if (!row) {
      throw notFound();
    }
    return row;
  }

  async findUnique(args: QueryArgs): Promise<Row | null> {
    const row = this.rows.find((candidate) => matchesWhere(candidate, args.where));
    return row ? pick(row, args.select) : null;
  }

  async findUniqueOrThrow(args: QueryArgs): Promise<Row> {
    const row = await this.findUnique(args);
    if (!row) {
      throw notFound();
    }
    return row;
  }

  async count(args: QueryArgs = {}): Promise<number> {
    return this.rows.filter((row) => matchesWhere(row, args.where)).length;
  }

  async aggregate(args: QueryArgs = {}): Promise<Row> {
    const rows = this.rows.filter((row) => matchesWhere(row, args.where));
    const result: Row = {};
    if (args._sum) {
      const sums: Row = {};
      for (const field of Object.keys(args._sum)) {
        sums[field] = rows.length
          ? rows.reduce((total, row) => total + Number(row[field] ?? 0), 0)
          : null;
      }
      result['_sum'] = sums;
    }
    if (args._count !== undefined) {
      result['_count'] = rows.length;
    }
    return result;
  }

  async create(args: QueryArgs): Promise<Row> {
    const row = this.withDefaults(args.data ?? {});
    this.assertUnique(row);
    this.rows.push(row);
    return pick(row, args.select);
  }

  async createMany(args: { data: Row[] }): Promise<{ count: number }> {
    for (const data of args.data) {
      await this.create({ data });
    }
    return { count: args.data.length };
  }

  async update(args: QueryArgs): Promise<Row> {
    const row = this.rows.find((candidate) => matchesWhere(candidate, args.where));
    if (!row) {
      throw notFound();
    }
    this.applyUpdate(row, args.data ?? {});
    this.assertUnique(row);
    return pick(row, args.select);
  }

  async updateMany(args: QueryArgs): Promise<{ count: number }> {
    const matched = this.rows.filter((row) => matchesWhere(row, args.where));
    for (const row of matched) {
      this.applyUpdate(row, args.data ?? {});
    }
    return { count: matched.length };
  }

  async upsert(args: QueryArgs): Promise<Row> {
    const row = this.rows.find((candidate) => matchesWhere(candidate, args.where));
    if (row) {
      this.applyUpdate(row, args.update ?? {});
      return pick(row, args.select);
    }
    return this.create({ data: args.create ?? {}, select: args.select });
  }

  async delete(args: QueryArgs): Promise<Row> {
    const index = this.rows.findIndex((candidate) => matchesWhere(candidate, args.where));
    if (index < 0) {
      throw notFound();
    }
    const [removed] = this.rows.splice(index, 1);
    return removed ?? {};
  }

  async deleteMany(args: QueryArgs = {}): Promise<{ count: number }> {
    const before = this.rows.length;
    const kept = this.rows.filter((row) => !matchesWhere(row, args.where));
    this.rows.length = 0;
    this.rows.push(...kept);
    return { count: before - kept.length };
  }

  private query(args: QueryArgs): Row[] {
    let rows = sortRows(
      this.rows.filter((row) => matchesWhere(row, args.where)),
      args.orderBy,
    );
    if (args.cursor) {
      const index = rows.findIndex((row) => matchesWhere(row, args.cursor));
      rows = index >= 0 ? rows.slice(index) : [];
    }
    if (args.skip) {
      rows = rows.slice(args.skip);
    }
    if (args.take !== undefined) {
      rows = args.take >= 0 ? rows.slice(0, args.take) : rows.slice(args.take);
    }
    return rows;
  }

  private withDefaults(data: Row): Row {
    const now = this.now();
    const defaults = this.definition.defaults ? this.definition.defaults(now) : {};
    const row: Row = { ...defaults };
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        row[key] = value;
      }
    }
    return row;
  }

  private applyUpdate(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) {
        continue;
      }
      if (
        isPlainObject(value) &&
        ('increment' in value || 'decrement' in value || 'set' in value)
      ) {
        if ('increment' in value) {
          row[key] = Number(row[key] ?? 0) + Number(value['increment']);
        } else if ('decrement' in value) {
          row[key] = Number(row[key] ?? 0) - Number(value['decrement']);
        } else {
          row[key] = value['set'];
        }
        continue;
      }
      row[key] = value;
    }
    if ('updatedAt' in row) {
      row['updatedAt'] = this.now();
    }
  }

  private assertUnique(row: Row): void {
    for (const keys of this.definition.uniques) {
      if (keys.some((key) => row[key] === null || row[key] === undefined)) {
        continue;
      }
      const duplicate = this.rows.some(
        (candidate) => candidate !== row && keys.every((key) => equal(candidate[key], row[key])),
      );
      if (duplicate) {
        throw uniqueViolation(keys);
      }
    }
  }
}

const MODELS: Record<string, ModelDefinition> = {
  vehicle: {
    uniques: [['id']],
    defaults: (now) => ({
      label: null,
      verified: false,
      verifiedVia: 'none',
      verifiedAt: null,
      isDefault: false,
      createdAt: now,
      deletedAt: null,
    }),
  },
  parkingSession: {
    uniques: [['id'], ['providerRef']],
    defaults: (now) => ({
      userId: null,
      vehicleId: null,
      plate: null,
      level: null,
      spot: null,
      exitedAt: null,
      status: 'open',
      paidUntil: null,
      amountDueKopecks: 0,
      amountPaidKopecks: 0,
      providerRef: null,
      lastSyncedAt: null,
      closedReason: null,
      presenceConfirmedAt: null,
      disputedAt: null,
      disputeReason: null,
      disputeComment: null,
      createdAt: now,
      updatedAt: now,
    }),
  },
  parkingTariff: {
    uniques: [['id'], ['version']],
    defaults: (now) => ({ createdById: null, createdAt: now }),
  },
  parkingPaymentLink: {
    uniques: [['sessionId', 'paymentId']],
    defaults: (now) => ({
      paidUntil: null,
      outcome: null,
      outcomeAt: null,
      registeredAt: null,
      createdAt: now,
    }),
  },
  parkingWebhookLog: {
    uniques: [['id'], ['provider', 'eventId']],
    defaults: (now) => ({ sessionId: null, receivedAt: now, processedAt: null, result: null }),
  },
  outboxEvent: {
    uniques: [['id']],
    defaults: (now) => ({ occurredAt: now, publishedAt: null, attempts: 0 }),
  },
  auditLog: {
    uniques: [['id']],
    defaults: (now) => ({
      actorId: null,
      entityId: null,
      before: null,
      after: null,
      reason: null,
      ip: null,
      createdAt: now,
    }),
  },
  featureFlag: {
    uniques: [['key']],
    defaults: (now) => ({ enabled: false, payload: null, updatedAt: now }),
  },
  idempotencyKey: {
    uniques: [['scope', 'key']],
    defaults: (now) => ({ status: null, response: null, createdAt: now }),
  },
};

export class FakePrisma {
  readonly vehicle: FakeModel;
  readonly parkingSession: FakeModel;
  readonly parkingTariff: FakeModel;
  readonly parkingPaymentLink: FakeModel;
  readonly parkingWebhookLog: FakeModel;
  readonly outboxEvent: FakeModel;
  readonly auditLog: FakeModel;
  readonly featureFlag: FakeModel;
  readonly idempotencyKey: FakeModel;

  constructor(private readonly now: () => Date = () => new Date()) {
    const model = (name: string): FakeModel => {
      const definition = MODELS[name];
      if (!definition) {
        throw new Error(`FakePrisma: unknown model ${name}`);
      }
      return new FakeModel(name, definition, this.now);
    };
    this.vehicle = model('vehicle');
    this.parkingSession = model('parkingSession');
    this.parkingTariff = model('parkingTariff');
    this.parkingPaymentLink = model('parkingPaymentLink');
    this.parkingWebhookLog = model('parkingWebhookLog');
    this.outboxEvent = model('outboxEvent');
    this.auditLog = model('auditLog');
    this.featureFlag = model('featureFlag');
    this.idempotencyKey = model('idempotencyKey');
  }

  /** Raw SQL is only used for row locks (`SELECT ... FOR UPDATE`): recorded, returns no rows. */
  readonly rawQueries: string[] = [];

  async $queryRaw(strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    this.rawQueries.push(strings.join('?'));
    return [];
  }

  async withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(this.asTx());
  }

  async runInTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(tx ?? this.asTx());
  }

  async $transaction<T>(input: ((tx: Tx) => Promise<T>) | Promise<unknown>[]): Promise<unknown> {
    if (typeof input === 'function') {
      return input(this.asTx());
    }
    return Promise.all(input);
  }

  async $connect(): Promise<void> {
    // nothing to open
  }

  async $disconnect(): Promise<void> {
    // nothing to close
  }

  async ping(): Promise<void> {
    // always healthy
  }

  async onModuleInit(): Promise<void> {
    // no connection
  }

  async onModuleDestroy(): Promise<void> {
    // no connection
  }

  clear(): void {
    for (const model of this.models()) {
      model.clear();
    }
  }

  /** Published outbox events in insertion order, typed loosely for assertions. */
  outboxTypes(): string[] {
    return this.outboxEvent.rows.map((row) => String(row['type']));
  }

  asTx(): Tx {
    return this as unknown as Tx;
  }

  asPrisma(): PrismaService {
    return this as unknown as PrismaService;
  }

  private models(): FakeModel[] {
    return [
      this.vehicle,
      this.parkingSession,
      this.parkingTariff,
      this.parkingPaymentLink,
      this.parkingWebhookLog,
      this.outboxEvent,
      this.auditLog,
      this.featureFlag,
      this.idempotencyKey,
    ];
  }
}
