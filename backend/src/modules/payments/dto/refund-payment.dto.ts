import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/** `POST /admin/payments/:id/refund` body. Omit `amountKopecks` for a full refund. */
export class RefundPaymentDto {
  @ApiPropertyOptional({
    description: 'Partial refund amount in kopecks; omitted means the whole refundable remainder',
    example: 2000,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amountKopecks?: number;

  @ApiProperty({
    example: 'Шлагбаум не відкрився, клієнт оплатив у паркоматі',
    minLength: 3,
    maxLength: 500,
  })
  @IsString()
  @Length(3, 500)
  reason: string;
}
