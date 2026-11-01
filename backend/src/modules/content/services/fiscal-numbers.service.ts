import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import type { FiscalNumberLookup, FiscalNumberStatus } from '../../../common/contracts/content';
import {
  CONTENT_EVENTS,
  OUTBOX_AGGREGATES,
  buildOutboxEvent,
} from '../../../common/contracts/events';
import { DomainError } from '../../../common/errors/domain-error';
import { OutboxService } from '../../../common/outbox/outbox.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { isUniqueViolation } from '../../../common/prisma/prisma.errors';
import { type DbClient, PrismaService, type Tx } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ContentErrors } from '../domain/errors';
import {
  fiscalNumberSearchPrefix,
  normalizeFiscalNumber,
  parseFiscalNumber,
} from '../domain/fiscal-number';
import {
  assertFiscalNumberDecision,
  decideFiscalNumberTransition,
} from '../domain/fiscal-number-state';
import type { CreateFiscalNumberDto, ListFiscalNumbersQueryDto } from '../dto/fiscal-number.dto';
import { type FiscalNumberWithTenant, toFiscalNumberLookup } from './mappers';
import { type AdminActor, isIdCursor, pick } from './types';

const WITH_TENANT = { tenant: true } satisfies Prisma.TenantFiscalNumberInclude;

const SNAPSHOT_FIELDS = [
  'fn',
  'tenantId',
  'status',
  'source',
  'note',
  'confirmedById',
  'confirmedAt',
] as const;

export interface FiscalNumberTransitionInput {
  status?: FiscalNumberStatus;
  /** `null` unmaps; omit to keep. */
  tenantId?: string | null;
  /** Omit to keep the current note. */
  note?: string | null;
}

export type FiscalNumberAction = 'update' | 'confirm' | 'block';

export interface RecordSeenOptions {
  /** Receipt that surfaced the number (goes into the `tenant.fiscal_number_seen` payload). */
  receiptId?: string | null;
}

/**
 * Whitelist of cash register fiscal numbers (`fn` of the tax QR). Receipts record unknown
 * numbers as `pending`; moderators map them to tenants (`active`) or block them.
 */
@Injectable()
export class FiscalNumbersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  /** ContentPort.findTenantByFiscalNumber: null for unknown or malformed numbers. */
  async lookup(fnInput: string): Promise<FiscalNumberLookup | null> {
    const parsed = parseFiscalNumber(fnInput);
    if (!parsed.ok) {
      return null;
    }
    const row = await this.prisma.tenantFiscalNumber.findUnique({
      where: { fn: parsed.fn },
      include: WITH_TENANT,
    });
    return row ? toFiscalNumberLookup(row) : null;
  }

  /**
   * ContentPort.recordSeenFiscalNumber: inserts a `pending` / `receipt` row unless the number
   * is already known. Uses `INSERT ... ON CONFLICT DO NOTHING` so a race inside the caller's
   * transaction cannot abort it; the event is published only for a fresh row.
   */
  async recordSeen(
    fnInput: string,
    tx?: Tx,
    options: RecordSeenOptions = {},
  ): Promise<FiscalNumberLookup> {
    const fn = normalizeFiscalNumber(fnInput);
    return this.prisma.runInTx(tx, async (db) => {
      const id = uuidv7();
      const nowIso = this.clock.now().toISOString();
      const inserted = await db.$executeRaw`
        INSERT INTO tenant_fiscal_numbers
          (id, fn, tenant_id, status, source, first_seen_at, created_at, updated_at)
        VALUES
          (${id}::uuid, ${fn}, NULL, 'pending'::"FiscalNumberStatus", 'receipt'::"FiscalNumberSource",
           ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${nowIso}::timestamptz)
        ON CONFLICT (fn) DO NOTHING`;
      const row = await db.tenantFiscalNumber.findUniqueOrThrow({
        where: { fn },
        include: WITH_TENANT,
      });
      if (inserted === 1) {
        await this.outbox.publish(
          db,
          buildOutboxEvent(
            CONTENT_EVENTS.fiscalNumberSeen,
            OUTBOX_AGGREGATES.fiscalNumber,
            row.id,
            {
              fn,
              receiptId: options.receiptId ?? null,
            },
          ),
        );
      }
      return toFiscalNumberLookup(row);
    });
  }

  /** Admin list, newest first (`id desc`, UUID v7 is time-ordered), cursor `{ id }`. */
  async list(query: ListFiscalNumbersQueryDto): Promise<Page<FiscalNumberWithTenant>> {
    const cursor = decodeCursor(query.cursor, isIdCursor);
    const prefix = fiscalNumberSearchPrefix(query.q);
    const where: Prisma.TenantFiscalNumberWhereInput = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.source !== undefined ? { source: query.source } : {}),
      ...(query.tenantId !== undefined ? { tenantId: query.tenantId } : {}),
      ...(query.unmapped ? { tenantId: null } : {}),
      ...(prefix ? { fn: { startsWith: prefix } } : {}),
      ...(cursor ? { id: { lt: cursor.id } } : {}),
    };
    const rows = await this.prisma.tenantFiscalNumber.findMany({
      where,
      include: WITH_TENANT,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, (last) => ({ id: last.id }));
  }

  async getById(id: string, db: DbClient = this.prisma): Promise<FiscalNumberWithTenant> {
    const row = await db.tenantFiscalNumber.findUnique({ where: { id }, include: WITH_TENANT });
    if (!row) {
      throw this.notFound({ id });
    }
    return row;
  }

  async create(input: CreateFiscalNumberDto, actor: AdminActor): Promise<FiscalNumberWithTenant> {
    const fn = normalizeFiscalNumber(input.fn);
    const tenantId = input.tenantId ?? null;
    const status: FiscalNumberStatus = input.status ?? (tenantId ? 'active' : 'pending');
    if (status === 'active' && tenantId === null) {
      throw new DomainError(
        ContentErrors.PC_FISCAL_NUMBER_TENANT_REQUIRED,
        'An active fiscal number must be mapped to a tenant',
      );
    }
    const now = this.clock.now();
    const confirmed = status !== 'pending';
    return this.prisma.withTx(async (tx) => {
      if (tenantId !== null) {
        await this.assertTenantExists(tx, tenantId);
      }
      const existing = await tx.tenantFiscalNumber.findUnique({
        where: { fn },
        select: { id: true, status: true, tenantId: true },
      });
      if (existing) {
        throw this.taken(fn, existing);
      }
      let row: FiscalNumberWithTenant;
      try {
        row = await tx.tenantFiscalNumber.create({
          data: {
            id: uuidv7(),
            fn,
            tenantId,
            status,
            source: 'admin',
            firstSeenAt: now,
            confirmedById: confirmed ? actor.id : null,
            confirmedAt: confirmed ? now : null,
            note: input.note ?? null,
            createdAt: now,
            updatedAt: now,
          },
          include: WITH_TENANT,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw this.taken(fn, null, error);
        }
        throw error;
      }
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'fiscal_number.create',
          entityType: 'tenant_fiscal_number',
          entityId: row.id,
          after: pick(row, SNAPSHOT_FIELDS),
          reason: input.note ?? null,
          ip: actor.ip ?? null,
        },
        tx,
      );
      if (confirmed) {
        await this.publishConfirmed(tx, row);
      }
      return row;
    });
  }

  /** PATCH: mapping, note and (optionally) status through the state machine. */
  update(
    id: string,
    patch: FiscalNumberTransitionInput,
    actor: AdminActor,
  ): Promise<FiscalNumberWithTenant> {
    return this.transition(id, patch, 'update', actor);
  }

  /** Moderator confirms the number: `active`, mapped to `tenantId` (or the current mapping). */
  confirm(
    id: string,
    input: { tenantId?: string; note?: string | null },
    actor: AdminActor,
  ): Promise<FiscalNumberWithTenant> {
    return this.transition(
      id,
      { status: 'active', tenantId: input.tenantId, note: input.note },
      'confirm',
      actor,
    );
  }

  block(
    id: string,
    input: { note?: string | null },
    actor: AdminActor,
  ): Promise<FiscalNumberWithTenant> {
    return this.transition(id, { status: 'blocked', note: input.note }, 'block', actor);
  }

  /** Deletes a pending or blocked number; an active one must be blocked instead. */
  async remove(id: string, actor: AdminActor): Promise<void> {
    await this.prisma.withTx(async (tx) => {
      const current = await this.getById(id, tx);
      if (current.status === 'active') {
        throw new DomainError(
          ContentErrors.PC_FISCAL_NUMBER_INVALID_TRANSITION,
          'Block an active fiscal number instead of deleting it',
          { details: { from: current.status, to: 'deleted' } },
        );
      }
      await tx.tenantFiscalNumber.delete({ where: { id } });
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'fiscal_number.delete',
          entityType: 'tenant_fiscal_number',
          entityId: id,
          before: pick(current, SNAPSHOT_FIELDS),
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
  }

  private async transition(
    id: string,
    target: FiscalNumberTransitionInput,
    action: FiscalNumberAction,
    actor: AdminActor,
  ): Promise<FiscalNumberWithTenant> {
    const now = this.clock.now();
    return this.prisma.withTx(async (tx) => {
      const current = await this.getById(id, tx);
      const decision = decideFiscalNumberTransition(current, {
        status: target.status,
        tenantId: target.tenantId,
      });
      assertFiscalNumberDecision(decision, current);
      if (decision.next.tenantId !== null && decision.next.tenantId !== current.tenantId) {
        await this.assertTenantExists(tx, decision.next.tenantId);
      }
      const noteChanged = target.note !== undefined && target.note !== current.note;
      if (!decision.changed && !noteChanged) {
        return current;
      }
      const statusChanged = decision.next.status !== current.status;
      const confirmation: Prisma.TenantFiscalNumberUncheckedUpdateInput = !statusChanged
        ? {}
        : decision.next.status === 'pending'
          ? { confirmedById: null, confirmedAt: null }
          : { confirmedById: actor.id, confirmedAt: now };
      const row = await tx.tenantFiscalNumber.update({
        where: { id },
        data: {
          status: decision.next.status,
          tenantId: decision.next.tenantId,
          ...(target.note !== undefined ? { note: target.note } : {}),
          ...confirmation,
          updatedAt: now,
        },
        include: WITH_TENANT,
      });
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: `fiscal_number.${action}`,
          entityType: 'tenant_fiscal_number',
          entityId: id,
          before: pick(current, SNAPSHOT_FIELDS),
          after: pick(row, SNAPSHOT_FIELDS),
          reason: target.note ?? null,
          ip: actor.ip ?? null,
        },
        tx,
      );
      const remappedWhileActive = row.status === 'active' && row.tenantId !== current.tenantId;
      if (statusChanged || remappedWhileActive) {
        await this.publishConfirmed(tx, row);
      }
      return row;
    });
  }

  private publishConfirmed(tx: Tx, row: FiscalNumberWithTenant): Promise<string> {
    return this.outbox.publish(
      tx,
      buildOutboxEvent(
        CONTENT_EVENTS.fiscalNumberConfirmed,
        OUTBOX_AGGREGATES.fiscalNumber,
        row.id,
        {
          fn: row.fn,
          tenantId: row.tenantId,
          status: row.status,
          confirmedById: row.confirmedById,
        },
      ),
    );
  }

  private async assertTenantExists(db: DbClient, tenantId: string): Promise<void> {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) {
      throw new DomainError(ContentErrors.PC_TENANT_NOT_FOUND, 'Tenant not found', {
        details: { id: tenantId },
      });
    }
  }

  private taken(
    fn: string,
    existing: { id: string; status: FiscalNumberStatus; tenantId: string | null } | null,
    cause?: unknown,
  ): DomainError {
    return new DomainError(
      ContentErrors.PC_FISCAL_NUMBER_TAKEN,
      `Fiscal number ${fn} is already registered`,
      {
        details: existing
          ? { fn, id: existing.id, status: existing.status, tenantId: existing.tenantId }
          : { fn },
        cause,
      },
    );
  }

  private notFound(details: Record<string, string>): DomainError {
    return new DomainError(ContentErrors.PC_FISCAL_NUMBER_NOT_FOUND, 'Fiscal number not found', {
      details,
    });
  }
}
