import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import {
  PAYMENT_PROVIDERS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  type PaymentProvider,
  type PaymentPurpose,
  type PaymentStatus,
} from '../../../common/contracts/payments';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';

/** `GET /payments?status=&cursor=&limit=` (member, own payments only). */
export class ListPaymentsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: PaymentStatus;
}

/** `GET /admin/payments` filters. `from`/`to` bound `createdAt` as `[from, to)` in UTC. */
export class AdminListPaymentsQueryDto extends ListPaymentsQueryDto {
  @ApiPropertyOptional({ enum: PAYMENT_PROVIDERS })
  @IsOptional()
  @IsIn(PAYMENT_PROVIDERS)
  provider?: PaymentProvider;

  @ApiPropertyOptional({ enum: PAYMENT_PURPOSES })
  @IsOptional()
  @IsIn(PAYMENT_PURPOSES)
  purpose?: PaymentPurpose;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-02-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
