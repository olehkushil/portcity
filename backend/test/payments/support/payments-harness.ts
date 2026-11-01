import { Prisma, type Payment, type PaymentWebhookLog } from '@prisma/client';
import type { AdminAuditPort, AuditEntry } from '../../../src/common/contracts/admin';
import type { OutboxEventInput } from '../../../src/common/outbox/outbox.types';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import type { PrismaService } from '../../../src/common/prisma/prisma.service';
import { FakeClock } from '../../../src/common/time/clock';
import {
  type PaymentsConfig,
  defaultPaymentsConfig,
} from '../../../src/modules/payments/payments.config';
import {
  FiscalizationPort,
  MockFiscalizationAdapter,
  NoopFiscalizationAdapter,
} from '../../../src/modules/payments/services/fiscalization.port';
import { MockCheckoutService } from '../../../src/modules/payments/services/mock-checkout.service';
import { PaymentWebhooksService } from '../../../src/modules/payments/services/payment-webhooks.service';
import { PaymentsErasureService } from '../../../src/modules/payments/services/payments-erasure.service';
import {
  type JobQueue,
  PaymentsService,
} from '../../../src/modules/payments/services/payments.service';
import { MockPaymentProvider } from '../../../src/modules/payments/services/providers/mock-payment-provider';
import { PaymentProviderRegistry } from '../../../src/modules/payments/services/providers/provider.registry';

type PaymentWhere = {
  id?: string | { in: string[] };
  idempotencyKey?: string;
  provider?: string;
  providerRef?: string;
  userId?: string;
  status?: string | { in: string[] };
  createdAt?: { lt?: Date };
};

function matchesPayment(row: Payment, where: PaymentWhere = {}): boolean {
  if (typeof where.id === 'string' && row.id !== where.id) {
    return false;
  }
  if (typeof where.id === 'object' && !where.id.in.includes(row.id)) {
    return false;
  }
  if (where.idempotencyKey !== undefined && row.idempotencyKey !== where.idempotencyKey) {
    return false;
  }
  if (where.provider !== undefined && row.provider !== where.provider) {
    return false;
  }
  if (where.providerRef !== undefined && row.providerRef !== where.providerRef) {
    return false;
  }
  if (where.userId !== undefined && row.userId !== where.userId) {
    return false;
  }
  if (typeof where.status === 'string' && row.status !== where.status) {
    return false;
  }
  if (typeof where.status === 'object' && !where.status.in.includes(row.status)) {
    return false;
  }
  if (where.createdAt?.lt && !(row.createdAt.getTime() < where.createdAt.lt.getTime())) {
    return false;
  }
  return true;
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/**
 * In-memory stand-in for the two payments tables plus `withTx`/`runInTx`/`$queryRaw`.
 * Covers exactly the Prisma calls made by PaymentsService and PaymentWebhooksService.
 */
export class FakePaymentsPrisma {
  readonly payments: Payment[] = [];
  readonly logs: PaymentWebhookLog[] = [];
  readonly rawQueries: string[] = [];
  /** Simulates a concurrent delivery that inserted the same webhook log row first. */
  failNextLogCreate = false;

  // Reads return copies, like Prisma: later writes must not mutate rows a caller already holds.
  readonly payment = {
    findUnique: async (args: { where: PaymentWhere }): Promise<Payment | null> => {
      const row = this.payments.find((entry) => matchesPayment(entry, args.where));
      return row ? { ...row } : null;
    },
    findFirst: async (args: { where: PaymentWhere }): Promise<Payment | null> => {
      const row = [...this.payments]
        .filter((entry) => matchesPayment(entry, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return row ? { ...row } : null;
    },
    findMany: async (args: { where?: PaymentWhere; take?: number }): Promise<Payment[]> => {
      const rows = this.payments
        .filter((row) => matchesPayment(row, args.where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => ({ ...row }));
      return args.take !== undefined ? rows.slice(0, args.take) : rows;
    },
    create: async (args: {
      data: Omit<Payment, 'fiscalReceiptUrl' | 'failureCode' | 'refundedKopecks' | 'paidAt'> &
        Partial<Payment>;
    }): Promise<Payment> => {
      if (this.payments.some((row) => row.idempotencyKey === args.data.idempotencyKey)) {
        throw uniqueViolation();
      }
      const row: Payment = {
        fiscalReceiptUrl: null,
        failureCode: null,
        refundedKopecks: 0,
        paidAt: null,
        ...args.data,
      };
      this.payments.push(row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Partial<Payment> }): Promise<Payment> => {
      const row = this.payments.find((entry) => entry.id === args.where.id);
      if (!row) {
        throw new Error(`payment ${args.where.id} not found`);
      }
      Object.assign(row, args.data);
      return { ...row };
    },
    updateMany: async (args: {
      where: PaymentWhere;
      data: Partial<Payment>;
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const row of this.payments) {
        if (matchesPayment(row, args.where)) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly paymentWebhookLog = {
    findUnique: async (args: {
      where: { provider_externalId: { provider: string; externalId: string } };
    }): Promise<PaymentWebhookLog | null> =>
      this.logs.find(
        (row) =>
          row.provider === args.where.provider_externalId.provider &&
          row.externalId === args.where.provider_externalId.externalId,
      ) ?? null,
    create: async (args: {
      data: Omit<PaymentWebhookLog, 'processedAt' | 'result'> & Partial<PaymentWebhookLog>;
    }): Promise<PaymentWebhookLog> => {
      if (
        this.failNextLogCreate ||
        this.logs.some(
          (row) => row.provider === args.data.provider && row.externalId === args.data.externalId,
        )
      ) {
        this.failNextLogCreate = false;
        throw uniqueViolation();
      }
      const row: PaymentWebhookLog = { processedAt: null, result: null, ...args.data };
      this.logs.push(row);
      return { ...row };
    },
    update: async (args: {
      where: { id: string };
      data: Partial<PaymentWebhookLog>;
    }): Promise<PaymentWebhookLog> => {
      const row = this.logs.find((entry) => entry.id === args.where.id);
      if (!row) {
        throw new Error(`log ${args.where.id} not found`);
      }
      Object.assign(row, args.data);
      return { ...row };
    },
    findMany: async (args: { where: { paymentId: string } }): Promise<PaymentWebhookLog[]> =>
      this.logs.filter((row) => row.paymentId === args.where.paymentId),
  };

  $queryRaw = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    this.rawQueries.push(strings.join('?'));
    return [];
  };

  withTx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  runInTx<T>(_tx: unknown, fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

export interface PaymentsHarness {
  prisma: FakePaymentsPrisma;
  clock: FakeClock;
  config: PaymentsConfig;
  mock: MockPaymentProvider;
  registry: PaymentProviderRegistry;
  fiscalization: FiscalizationPort;
  payments: TestPaymentsService;
  webhooks: PaymentWebhooksService;
  checkout: MockCheckoutService;
  erasure: PaymentsErasureService;
  events: OutboxEventInput[];
  audits: Array<{ entry: AuditEntry; tx: unknown }>;
  queued: Array<{ name: string; data: unknown; jobId?: string; attempts?: number }>;
}

/** PaymentsService without real pauses (the wait for a concurrent checkout is instant in tests). */
export class TestPaymentsService extends PaymentsService {
  sleeps = 0;

  protected override sleep(): Promise<void> {
    this.sleeps += 1;
    return Promise.resolve();
  }
}

export const HARNESS_NOW = '2026-11-01T10:00:00.000Z';
export const MEMBER_ID = '01900000-0000-7000-8000-000000000001';

/** Wires the real payments services, the real mock provider and in-memory infrastructure. */
export function createPaymentsHarness(
  options: {
    config?: Partial<PaymentsConfig>;
    fiscalization?: 'none' | 'mock';
    /** Run the mock like a real (strict) acquirer for webhook checks. */
    strictWebhooks?: boolean;
  } = {},
): PaymentsHarness {
  const prisma = new FakePaymentsPrisma();
  const clock = new FakeClock(HARNESS_NOW);
  const config = defaultPaymentsConfig({
    PAYMENTS_MOCK_WEBHOOK_SECRET: 'test-webhook-secret',
    PAYMENTS_MOCK_CHECKOUT_BASE_URL: 'http://localhost:3000/api/v1/mock-checkout',
    ...options.config,
  });
  const mock = new MockPaymentProvider({
    secret: config.PAYMENTS_MOCK_WEBHOOK_SECRET,
    checkoutBaseUrl: config.PAYMENTS_MOCK_CHECKOUT_BASE_URL,
    now: () => clock.now(),
    checkoutTtlMinutes: config.PAYMENTS_PENDING_TIMEOUT_MINUTES,
    strictWebhooks: options.strictWebhooks ?? false,
  });
  const registry = new PaymentProviderRegistry([mock], 'mock');
  const fiscalization: FiscalizationPort =
    options.fiscalization === 'mock'
      ? new MockFiscalizationAdapter('http://localhost:3000/mock-fiscal')
      : new NoopFiscalizationAdapter();
  const events: OutboxEventInput[] = [];
  const outbox = {
    publish: async (_tx: unknown, event: OutboxEventInput): Promise<string> => {
      events.push(event);
      return `evt-${events.length}`;
    },
  } as unknown as OutboxService;
  const audits: Array<{ entry: AuditEntry; tx: unknown }> = [];
  const audit: AdminAuditPort = {
    audit: async (entry, tx) => {
      audits.push({ entry, tx });
      return `audit-${audits.length}`;
    },
  };
  const queued: Array<{ name: string; data: unknown; jobId?: string; attempts?: number }> = [];
  const queue: JobQueue = {
    add: async (name, data, opts) => {
      queued.push({ name, data, jobId: opts?.jobId, attempts: opts?.attempts });
      return {};
    },
  };
  const db = prisma as unknown as PrismaService;
  const payments = new TestPaymentsService(
    db,
    clock,
    outbox,
    registry,
    fiscalization,
    config,
    queue,
    audit,
  );
  const webhooks = new PaymentWebhooksService(db, clock, registry, payments, config);
  const checkout = new MockCheckoutService(config, mock, webhooks, payments);
  const erasure = new PaymentsErasureService(db);
  return {
    erasure,
    prisma,
    clock,
    config,
    mock,
    registry,
    fiscalization,
    payments,
    webhooks,
    checkout,
    events,
    audits,
    queued,
  };
}
