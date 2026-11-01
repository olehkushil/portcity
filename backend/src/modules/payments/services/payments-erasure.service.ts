import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { erasePersonalMeta } from '../domain/erasure';

export interface PaymentsErasureSummary {
  userId: string;
  /** Payments of the user inspected. */
  checked: number;
  /** Payments whose meta held personal data and was rewritten. */
  scrubbed: number;
}

/**
 * `user.deleted`: payments are financial records and stay (amounts, statuses, provider refs and
 * the anonymised owner); personal details copied into `meta` (plate, contact data, the plate
 * inside the internal checkout description) are removed. Idempotent: a repeated delivery
 * rewrites nothing.
 */
@Injectable()
export class PaymentsErasureService {
  private readonly logger = new Logger(PaymentsErasureService.name);

  constructor(private readonly prisma: PrismaService) {}

  async eraseUser(userId: string): Promise<PaymentsErasureSummary> {
    return this.prisma.withTx(async (tx) => {
      const rows = await tx.payment.findMany({ where: { userId } });
      let scrubbed = 0;
      for (const row of rows) {
        const erased = erasePersonalMeta(row.meta, row.purpose);
        if (!erased.changed) {
          continue;
        }
        await tx.payment.update({
          where: { id: row.id },
          data: { meta: erased.meta as Prisma.InputJsonObject },
        });
        scrubbed += 1;
      }
      if (scrubbed > 0) {
        this.logger.log(`Removed personal data from ${scrubbed} payment(s) of user ${userId}`);
      }
      return { userId, checked: rows.length, scrubbed };
    });
  }
}
