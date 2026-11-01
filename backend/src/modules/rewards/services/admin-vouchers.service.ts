import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import type { VoucherKind } from '../../../common/contracts/rewards';
import type { ActorRef } from '../../../common/contracts/shared';
import type { Page } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { VoucherView } from './voucher.mapper';
import { type AdminVoucherListQuery, VoucherService } from './voucher.service';

export interface AdminVoucherContext {
  actor: ActorRef;
  ip?: string | null | undefined;
}

export interface AdminIssueVoucherInput {
  userId: string;
  kind: VoucherKind;
  title: string;
  subtitle?: string | undefined;
  tenantId?: string | undefined;
  expiresAt?: Date | null | undefined;
  meta?: Record<string, unknown> | undefined;
  reason?: string | undefined;
}

export interface AdminCancelVoucherInput {
  reason: string;
  refundPoints?: boolean | undefined;
}

/**
 * Back-office voucher operations (`/admin/vouchers`): search, goodwill vouchers issued by an
 * operator (sourceType `admin`) and cancellation with the points policy. Each mutation runs
 * in one transaction with its audit row.
 */
@Injectable()
export class AdminVouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vouchers: VoucherService,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  list(query: AdminVoucherListQuery): Promise<Page<VoucherView>> {
    return this.vouchers.listForAdmin(query);
  }

  get(voucherId: string): Promise<VoucherView> {
    return this.vouchers.getById(voucherId);
  }

  /** Every call is a new admin action (fresh sourceId); the endpoint is idempotent by key. */
  async issue(input: AdminIssueVoucherInput, context: AdminVoucherContext): Promise<VoucherView> {
    const actionId = uuidv7();
    const summary = await this.prisma.withTx(async (tx) => {
      const voucher = await this.vouchers.issue(
        {
          userId: input.userId,
          kind: input.kind,
          title: input.title,
          ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
          ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
          expiresAt: input.expiresAt ?? null,
          sourceType: 'admin',
          sourceId: actionId,
          meta: {
            ...(input.meta ?? {}),
            issuedByAdminId: context.actor.id ?? null,
            ...(input.reason ? { issueReason: input.reason } : {}),
          },
        },
        tx,
      );
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'voucher.issue',
          entityType: 'voucher',
          entityId: voucher.id,
          after: {
            userId: voucher.userId,
            kind: voucher.kind,
            title: voucher.title,
            tenantId: voucher.tenantId,
            expiresAt: voucher.expiresAt,
          },
          reason: input.reason ?? null,
          ip: context.ip ?? null,
        },
        tx,
      );
      return voucher;
    });
    return this.vouchers.decorateOne(summary);
  }

  async cancel(
    voucherId: string,
    input: AdminCancelVoucherInput,
    context: AdminVoucherContext,
  ): Promise<VoucherView> {
    const summary = await this.prisma.withTx(async (tx) => {
      const voucher = await this.vouchers.cancel(
        { voucherId, reason: input.reason, actor: context.actor, refundPoints: input.refundPoints },
        tx,
      );
      await this.audit.audit(
        {
          actor: context.actor,
          action: 'voucher.cancel',
          entityType: 'voucher',
          entityId: voucherId,
          after: { status: voucher.status, refundPoints: input.refundPoints ?? true },
          reason: input.reason,
          ip: context.ip ?? null,
        },
        tx,
      );
      return voucher;
    });
    return this.vouchers.decorateOne(summary);
  }
}
