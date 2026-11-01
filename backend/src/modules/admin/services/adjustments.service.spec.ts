import type { AdminAuditPort, AuditEntry } from '../../../common/contracts/admin';
import type {
  ClubLedgerPort,
  CreditPointsInput,
  LedgerEntry,
  PointsBalance,
  SpendPointsInput,
} from '../../../common/contracts/club';
import { DomainError } from '../../../common/errors/domain-error';
import type { OutboxEventInput } from '../../../common/outbox/outbox.types';
import type { OutboxService } from '../../../common/outbox/outbox.service';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { FakeClock } from '../../../common/time/clock';
import { AdjustmentsService } from './adjustments.service';

/**
 * Four-eyes flow of manual adjustments against in-memory fakes of Prisma (manual_adjustments),
 * CLUB_LEDGER_PORT, ADMIN_AUDIT_PORT and the outbox.
 */

const MEMBER = '01900000-0000-7000-8000-000000000001';
const MEMBER_WITHOUT_ACCOUNT = '01900000-0000-7000-8000-000000000002';
const ACCOUNT = '01900000-0000-7000-8000-0000000000a1';
const SUPPORT = { id: '01900000-0000-7000-8000-0000000000c1', ip: '10.0.0.1' };
const MANAGER = { id: '01900000-0000-7000-8000-0000000000c2', ip: '10.0.0.2' };

interface Row {
  id: string;
  accountId: string;
  userId: string;
  amount: number;
  reason: string;
  requestedById: string;
  approvedById: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  pointsTxId: string | null;
  thresholdPoints: number;
  secondApprovalReason: string | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type Where = {
  id?: string;
  status?: string | { in: string[] };
  userId?: string;
  accountId?: string;
  requestedById?: string;
  secondApprovalReason?: string | null;
  createdAt?: { gte: Date };
};

function matches(row: Row, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }
  if (where.userId !== undefined && row.userId !== where.userId) {
    return false;
  }
  if (where.accountId !== undefined && row.accountId !== where.accountId) {
    return false;
  }
  if (where.requestedById !== undefined && row.requestedById !== where.requestedById) {
    return false;
  }
  if (
    where.secondApprovalReason !== undefined &&
    row.secondApprovalReason !== where.secondApprovalReason
  ) {
    return false;
  }
  if (where.createdAt !== undefined && row.createdAt.getTime() < where.createdAt.gte.getTime()) {
    return false;
  }
  if (typeof where.status === 'string' && row.status !== where.status) {
    return false;
  }
  if (typeof where.status === 'object' && !where.status.in.includes(row.status)) {
    return false;
  }
  return true;
}

/** Only manual_adjustments: the service must not touch loyalty_accounts (no `include`). */
class FakePrisma {
  readonly rows: Row[] = [];
  readonly includes: unknown[] = [];

  private plain(row: Row, args: { include?: unknown }): Row {
    if (args.include !== undefined) {
      this.includes.push(args.include);
    }
    return { ...row };
  }

  readonly manualAdjustment = {
    create: async (args: {
      data: Omit<Row, 'pointsTxId' | 'appliedAt' | 'rejectionReason' | 'secondApprovalReason'> &
        Partial<Row>;
      include?: unknown;
    }) => {
      const row: Row = {
        pointsTxId: null,
        appliedAt: null,
        rejectionReason: null,
        secondApprovalReason: null,
        ...args.data,
      };
      this.rows.push(row);
      return this.plain(row, args);
    },
    findUnique: async (args: { where: { id: string }; include?: unknown }) => {
      const row = this.rows.find((entry) => entry.id === args.where.id);
      return row ? this.plain(row, args) : null;
    },
    findMany: async (args: { where: Where; take?: number; include?: unknown }) =>
      this.rows
        .filter((row) => matches(row, args.where))
        .slice(0, args.take ?? this.rows.length)
        .map((row) => this.plain(row, args)),
    updateMany: async (args: { where: Where; data: Partial<Row> }) => {
      let count = 0;
      for (const row of this.rows) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
    update: async (args: { where: { id: string }; data: Partial<Row>; include?: unknown }) => {
      const row = this.rows.find((entry) => entry.id === args.where.id);
      if (!row) {
        throw new Error('row not found');
      }
      Object.assign(row, args.data);
      return this.plain(row, args);
    },
  };

  readonly $queryRaw = jest.fn(async () => []);
  /** Advisory locks: records the lock keys (template values). */
  readonly $executeRaw = jest.fn(
    async (_strings: TemplateStringsArray, ..._values: unknown[]) => 1,
  );

  withTx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function balance(userId: string): PointsBalance {
  return {
    accountId: ACCOUNT,
    userId,
    available: 320,
    pending: 0,
    lifetimeEarned: 380,
    newcomerLockUntil: null,
    spendBlockedBy: null,
  };
}

function entry(input: CreditPointsInput | SpendPointsInput, type: 'adjust' | 'spend'): LedgerEntry {
  return {
    id: `tx-${input.idempotencyKey}`,
    accountId: ACCOUNT,
    userId: input.userId,
    type,
    state: type === 'spend' ? 'spent' : 'available',
    amount: type === 'spend' ? -input.amount : input.amount,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    idempotencyKey: input.idempotencyKey,
    availableAt: null,
    expiresAt: null,
    reason: input.reason ?? null,
    createdById: input.createdById ?? null,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
  };
}

function setup() {
  const prisma = new FakePrisma();
  const clock = new FakeClock('2026-01-15T10:00:00.000Z');
  const events: OutboxEventInput[] = [];
  const outbox = {
    publish: jest.fn(async (_tx: unknown, event: OutboxEventInput) => {
      events.push(event);
      return `evt-${events.length}`;
    }),
  };
  const audits: AuditEntry[] = [];
  const audit: AdminAuditPort = {
    audit: jest.fn(async (auditEntry: AuditEntry) => {
      audits.push(auditEntry);
      return `audit-${audits.length}`;
    }),
  };
  const ledger = {
    getBalance: jest.fn(async (userId: string) => (userId === MEMBER ? balance(userId) : null)),
    getEntry: jest.fn(),
    getActiveRules: jest.fn(),
    credit: jest.fn(async (input: CreditPointsInput) => entry(input, 'adjust')),
    hold: jest.fn(),
    release: jest.fn(),
    spend: jest.fn(async (input: SpendPointsInput) => entry(input, 'spend')),
    reverse: jest.fn(),
    getDailyStats: jest.fn(),
  } satisfies ClubLedgerPort;
  const service = new AdjustmentsService(
    prisma as unknown as PrismaService,
    clock,
    outbox as unknown as OutboxService,
    ledger,
    audit,
  );
  return { service, prisma, ledger, events, audits, clock };
}

function caught(fn: () => Promise<unknown>): Promise<DomainError> {
  return fn().then(
    () => {
      throw new Error('expected a DomainError');
    },
    (error: unknown) => {
      if (!DomainError.is(error)) {
        throw error;
      }
      return error;
    },
  );
}

describe('AdjustmentsService (four eyes)', () => {
  it('applies an adjustment up to the threshold right away through the club ledger', async () => {
    const { service, ledger, events, audits } = setup();

    const view = await service.request(
      { userId: MEMBER, amount: 150, reason: '  Компенсація за збій  ' },
      SUPPORT,
    );

    expect(view.status).toBe('applied');
    expect(view.needsSecondApproval).toBe(false);
    expect(view.approvedById).toBe(SUPPORT.id);
    expect(view.reason).toBe('Компенсація за збій');
    expect(ledger.credit).toHaveBeenCalledTimes(1);
    expect(ledger.credit).toHaveBeenCalledWith(
      {
        userId: MEMBER,
        amount: 150,
        type: 'adjust',
        sourceType: 'manual',
        sourceId: view.id,
        idempotencyKey: `adjustment:${view.id}`,
        reason: 'Компенсація за збій',
        createdById: SUPPORT.id,
      },
      expect.anything(),
    );
    expect(view.pointsTxId).toBe(`tx-adjustment:${view.id}`);
    expect(events.map((event) => event.type)).toEqual([
      'adjustment.requested',
      'adjustment.approved',
      'adjustment.applied',
    ]);
    expect(audits.map((auditEntry) => auditEntry.action)).toEqual([
      'manual_adjustment.request',
      'manual_adjustment.apply',
    ]);
    expect(audits[0]).toMatchObject({ actor: { type: 'admin', id: SUPPORT.id }, ip: '10.0.0.1' });
  });

  it('treats exactly 500 points as a single-admin decision', async () => {
    const { service, ledger } = setup();
    const view = await service.request({ userId: MEMBER, amount: 500, reason: 'Межа' }, SUPPORT);
    expect(view.status).toBe('applied');
    expect(ledger.credit).toHaveBeenCalledTimes(1);
  });

  it('keeps an adjustment above 500 points pending until a second admin approves it', async () => {
    const { service, ledger, events } = setup();

    const view = await service.request(
      { userId: MEMBER, amount: 501, reason: 'Великий бонус' },
      SUPPORT,
    );

    expect(view.status).toBe('pending');
    expect(view.needsSecondApproval).toBe(true);
    expect(view.approvedById).toBeNull();
    expect(view.decidedAt).toBeNull();
    expect(ledger.credit).not.toHaveBeenCalled();
    expect(ledger.spend).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['adjustment.requested']);
    expect(events[0]?.payload).toMatchObject({ needsSecondApproval: true, amount: 501 });
  });

  it('refuses approval by the admin who requested the adjustment', async () => {
    const { service, ledger } = setup();
    const view = await service.request({ userId: MEMBER, amount: 900, reason: 'Помилка' }, MANAGER);

    const error = await caught(() => service.approve(view.id, MANAGER));

    expect(error.code).toBe('PC_ADJUSTMENT_SELF_APPROVAL');
    expect(error.status).toBe(422);
    expect(ledger.credit).not.toHaveBeenCalled();
    expect((await service.get(view.id)).status).toBe('pending');
  });

  it('applies through the ledger once a different admin approves', async () => {
    const { service, ledger, events, audits } = setup();
    const view = await service.request({ userId: MEMBER, amount: 900, reason: 'Помилка' }, SUPPORT);

    const approved = await service.approve(view.id, MANAGER);

    expect(approved.status).toBe('applied');
    expect(approved.approvedById).toBe(MANAGER.id);
    expect(approved.appliedAt).toEqual(new Date('2026-01-15T10:00:00.000Z'));
    expect(ledger.credit).toHaveBeenCalledTimes(1);
    expect(ledger.credit.mock.calls[0]?.[0]).toMatchObject({
      amount: 900,
      createdById: MANAGER.id,
      idempotencyKey: `adjustment:${view.id}`,
    });
    expect(events.map((event) => event.type)).toEqual([
      'adjustment.requested',
      'adjustment.approved',
      'adjustment.applied',
    ]);
    expect(audits.map((auditEntry) => auditEntry.action)).toEqual([
      'manual_adjustment.request',
      'manual_adjustment.approve',
      'manual_adjustment.apply',
    ]);
  });

  it('debits negative amounts through ledger.spend', async () => {
    const { service, ledger } = setup();
    const view = await service.request(
      { userId: MEMBER, amount: -700, reason: 'Шахрайство' },
      SUPPORT,
    );
    expect(view.status).toBe('pending');

    const applied = await service.approve(view.id, MANAGER);

    expect(applied.status).toBe('applied');
    expect(ledger.credit).not.toHaveBeenCalled();
    expect(ledger.spend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: MEMBER, amount: 700, sourceType: 'manual' }),
      expect.anything(),
    );
  });

  it('keeps an approved adjustment approved when the ledger refuses, so apply can retry', async () => {
    const { service, ledger } = setup();
    const view = await service.request(
      { userId: MEMBER, amount: -900, reason: 'Списання' },
      SUPPORT,
    );
    ledger.spend.mockRejectedValueOnce(
      new DomainError('PC_POINTS_INSUFFICIENT', 'Not enough points', { status: 422 }),
    );

    const error = await caught(() => service.approve(view.id, MANAGER));

    expect(error.code).toBe('PC_POINTS_INSUFFICIENT');
    expect(error.details).toMatchObject({ adjustmentId: view.id, adjustmentStatus: 'approved' });
    expect((await service.get(view.id)).status).toBe('approved');

    const retried = await service.apply(view.id, MANAGER);
    expect(retried.status).toBe('applied');
    expect(ledger.spend).toHaveBeenCalledTimes(2);
  });

  it('refuses apply on a pending adjustment', async () => {
    const { service } = setup();
    const view = await service.request({ userId: MEMBER, amount: 800, reason: 'Бонус' }, SUPPORT);
    const error = await caught(() => service.apply(view.id, MANAGER));
    expect(error.code).toBe('PC_ADJUSTMENT_APPROVAL_REQUIRED');
  });

  it('returns an applied adjustment unchanged on a repeated approve', async () => {
    const { service, ledger } = setup();
    const view = await service.request({ userId: MEMBER, amount: 800, reason: 'Бонус' }, SUPPORT);
    await service.approve(view.id, MANAGER);
    const error = await caught(() => service.approve(view.id, MANAGER));
    expect(error.code).toBe('PC_ADJUSTMENT_INVALID_TRANSITION');
    expect(ledger.credit).toHaveBeenCalledTimes(1);
  });

  it('rejects a pending adjustment and blocks later approval', async () => {
    const { service, ledger, events } = setup();
    const view = await service.request({ userId: MEMBER, amount: 2000, reason: 'Бонус' }, SUPPORT);

    const rejected = await service.reject(view.id, '  Дублікат  ', MANAGER);

    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('Дублікат');
    expect(events.at(-1)?.type).toBe('adjustment.rejected');
    const error = await caught(() => service.approve(view.id, MANAGER));
    expect(error.code).toBe('PC_ADJUSTMENT_INVALID_TRANSITION');
    expect(ledger.credit).not.toHaveBeenCalled();
  });

  it('refuses to reject an applied adjustment', async () => {
    const { service } = setup();
    const view = await service.request({ userId: MEMBER, amount: 10, reason: 'Дрібниця' }, SUPPORT);
    const error = await caught(() => service.reject(view.id, 'Запізно', MANAGER));
    expect(error.code).toBe('PC_ADJUSTMENT_INVALID_TRANSITION');
    expect(error.status).toBe(409);
  });

  it('fails when the member has no loyalty account', async () => {
    const { service, prisma } = setup();
    const error = await caught(() =>
      service.request({ userId: MEMBER_WITHOUT_ACCOUNT, amount: 10, reason: 'Бонус' }, SUPPORT),
    );
    expect(error.code).toBe('PC_ADJUSTMENT_ACCOUNT_NOT_FOUND');
    expect(prisma.rows).toHaveLength(0);
  });

  it('rejects zero and oversized amounts before touching the database', async () => {
    const { service, ledger } = setup();
    for (const amount of [0, 1.5, 2_000_000]) {
      const error = await caught(() =>
        service.request({ userId: MEMBER, amount, reason: 'Невалідне' }, SUPPORT),
      );
      expect(error.code).toBe('PC_ADJUSTMENT_AMOUNT_INVALID');
    }
    expect(ledger.getBalance).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown adjustment', async () => {
    const { service } = setup();
    const error = await caught(() => service.get('01900000-0000-7000-8000-00000000dead'));
    expect(error.code).toBe('PC_ADJUSTMENT_NOT_FOUND');
    expect(error.status).toBe(404);
  });

  it('lists by status and by member (empty for a member without an account)', async () => {
    const { service } = setup();
    await service.request({ userId: MEMBER, amount: 10, reason: 'Малий' }, SUPPORT);
    await service.request({ userId: MEMBER, amount: 1000, reason: 'Великий' }, SUPPORT);

    const pending = await service.list({ status: 'pending' }, { limit: 20 });
    expect(pending.items.map((item) => item.amount)).toEqual([1000]);

    const mine = await service.list({ userId: MEMBER }, { limit: 20 });
    expect(mine.items).toHaveLength(2);

    const none = await service.list({ userId: MEMBER_WITHOUT_ACCOUNT }, { limit: 20 });
    expect(none).toEqual({ items: [], nextCursor: null });
  });

  describe('cumulative self-approval (split adjustments)', () => {
    const OTHER_SUPPORT = { id: '01900000-0000-7000-8000-0000000000c3', ip: '10.0.0.3' };

    it('sends the part that brings the requester over 500 points today to a second admin', async () => {
      const { service, ledger, prisma } = setup();
      const first = await service.request(
        { userId: MEMBER, amount: 300, reason: 'Частина 1' },
        SUPPORT,
      );
      expect(first).toMatchObject({ status: 'applied', secondApprovalReason: null });

      const second = await service.request(
        { userId: MEMBER, amount: 300, reason: 'Частина 2' },
        SUPPORT,
      );
      expect(second).toMatchObject({
        status: 'pending',
        needsSecondApproval: true,
        secondApprovalReason: 'requester_daily_total',
        approvedById: null,
      });
      expect(ledger.credit).toHaveBeenCalledTimes(1);
      expect(prisma.rows[1]?.secondApprovalReason).toBe('requester_daily_total');

      // The second admin approves it as usual.
      const applied = await service.approve(second.id, MANAGER);
      expect(applied.status).toBe('applied');
      expect(applied.secondApprovalReason).toBe('requester_daily_total');
    });

    it('counts debits by absolute value and ignores pending, rejected and second-approved rows', async () => {
      const { service } = setup();
      await service.request({ userId: MEMBER, amount: -200, reason: 'Списання' }, SUPPORT);
      const big = await service.request({ userId: MEMBER, amount: 900, reason: 'Велике' }, SUPPORT);
      await service.reject(big.id, 'Не треба', MANAGER);
      const third = await service.request({ userId: MEMBER, amount: 300, reason: 'Ще' }, SUPPORT);
      expect(third.status).toBe('applied');
      const fourth = await service.request(
        { userId: MEMBER, amount: 1, reason: 'Останнє' },
        SUPPORT,
      );
      expect(fourth).toMatchObject({
        status: 'pending',
        secondApprovalReason: 'requester_daily_total',
      });
    });

    it('checks the target account over 24 hours across requesters', async () => {
      const { service } = setup();
      await service.request({ userId: MEMBER, amount: 400, reason: 'Від першого' }, SUPPORT);
      const view = await service.request(
        { userId: MEMBER, amount: 150, reason: 'Від другого' },
        OTHER_SUPPORT,
      );
      expect(view).toMatchObject({ status: 'pending', secondApprovalReason: 'account_24h_total' });
    });

    it('resets the requester total on the next Kyiv day but keeps the rolling account window', async () => {
      const { service, clock } = setup();
      // 2026-01-15 21:30 Kyiv (UTC+2).
      clock.set('2026-01-15T19:30:00.000Z');
      await service.request({ userId: MEMBER, amount: 400, reason: 'Ввечері' }, SUPPORT);
      // 00:30 Kyiv next day: new requester day, but the account saw 400 within 24 h.
      clock.set('2026-01-15T22:30:00.000Z');
      const sameAccount = await service.request(
        { userId: MEMBER, amount: 200, reason: 'Вночі' },
        SUPPORT,
      );
      expect(sameAccount.secondApprovalReason).toBe('account_24h_total');
      // 25 hours later both windows are clear.
      clock.set('2026-01-16T20:31:00.000Z');
      const later = await service.request(
        { userId: MEMBER, amount: 450, reason: 'Завтра' },
        SUPPORT,
      );
      expect(later).toMatchObject({ status: 'applied', secondApprovalReason: null });
    });

    it('locks the requester and the account before reading the totals', async () => {
      const { service, prisma } = setup();
      await service.request({ userId: MEMBER, amount: 50, reason: 'Замок' }, SUPPORT);
      const lockKeys = prisma.$executeRaw.mock.calls.map((call) => call[1]);
      expect(lockKeys).toEqual([
        `manual_adjustment:requester:${SUPPORT.id}`,
        `manual_adjustment:account:${ACCOUNT}`,
      ]);
    });

    it('keeps the single-amount rule for legacy rows without a stored reason', async () => {
      const { service, prisma } = setup();
      const view = await service.request({ userId: MEMBER, amount: 900, reason: 'Старе' }, SUPPORT);
      const row = prisma.rows.find((entry) => entry.id === view.id);
      if (row) {
        row.secondApprovalReason = null;
      }
      expect(await service.get(view.id)).toMatchObject({
        needsSecondApproval: true,
        secondApprovalReason: 'amount',
      });
    });
  });

  it('stores the owner on the row and never reads the club account table', async () => {
    const { service, prisma, ledger, events } = setup();
    const view = await service.request({ userId: MEMBER, amount: 900, reason: 'Помилка' }, SUPPORT);
    expect(prisma.rows[0]).toMatchObject({ id: view.id, accountId: ACCOUNT, userId: MEMBER });
    expect(view.userId).toBe(MEMBER);
    expect(events[0]?.payload).toMatchObject({ userId: MEMBER, accountId: ACCOUNT });

    ledger.getBalance.mockClear();
    await service.list({ userId: MEMBER }, { limit: 20 });
    await service.get(view.id);
    await service.approve(view.id, MANAGER);
    // The ledger port is asked for the account only when an adjustment is requested.
    expect(ledger.getBalance).not.toHaveBeenCalled();
    expect(prisma.includes).toEqual([]);
  });
});
