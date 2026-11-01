import { ApiProperty } from '@nestjs/swagger';
import type { SpendBlockReason } from '../../../common/contracts/club';
import type { AdminClubAccountView } from '../services/club-account.service';
import { isoOrNull } from '../services/mappers';

export class ClubWelcomeStateDto {
  @ApiProperty()
  register: boolean;

  @ApiProperty()
  profile: boolean;

  @ApiProperty()
  firstReceipt: boolean;
}

export class PointsExpiryBucketDto {
  @ApiProperty({ description: 'Kyiv calendar day', example: '2027-03-01' })
  expiresOn: string;

  @ApiProperty({ example: 120 })
  remaining: number;
}

export class AdminClubAccountDto {
  @ApiProperty({ format: 'uuid' })
  accountId: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ example: 320 })
  available: number;

  @ApiProperty({ example: 0 })
  pending: number;

  @ApiProperty({ example: 380 })
  lifetimeEarned: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  newcomerLockUntil: string | null;

  @ApiProperty({ enum: ['negative_balance', 'newcomer_lock'], nullable: true })
  spendBlockedBy: SpendBlockReason | null;

  @ApiProperty({ type: ClubWelcomeStateDto })
  welcomeState: ClubWelcomeStateDto;

  @ApiProperty({
    type: [PointsExpiryBucketDto],
    description: 'FIFO expiry buckets, earliest first',
  })
  buckets: PointsExpiryBucketDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export function toAdminClubAccountDto(view: AdminClubAccountView): AdminClubAccountDto {
  return {
    accountId: view.balance.accountId,
    userId: view.balance.userId,
    available: view.balance.available,
    pending: view.balance.pending,
    lifetimeEarned: view.balance.lifetimeEarned,
    newcomerLockUntil: isoOrNull(view.balance.newcomerLockUntil),
    spendBlockedBy: view.balance.spendBlockedBy,
    welcomeState: { ...view.welcomeState },
    buckets: view.buckets.map((bucket) => ({
      expiresOn: bucket.dayKey,
      remaining: bucket.remaining,
    })),
    createdAt: view.createdAt.toISOString(),
  };
}
