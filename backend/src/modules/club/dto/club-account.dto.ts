import { ApiProperty } from '@nestjs/swagger';
import type { SpendBlockReason } from '../../../common/contracts/club';
import type { ClubAccountView } from '../services/club-account.service';
import { isoOrNull } from '../services/mappers';

const SPEND_BLOCK_REASONS: readonly SpendBlockReason[] = ['negative_balance', 'newcomer_lock'];

export class PointsNearestExpiryDto {
  @ApiProperty({
    description: 'Kyiv calendar day on which the points expire',
    example: '2027-03-01',
  })
  expiresOn: string;

  @ApiProperty({ example: 30 })
  points: number;
}

export class PointsExpiringSoonDto {
  @ApiProperty({ description: 'Window in days starting today (Kyiv)', example: 30 })
  withinDays: number;

  @ApiProperty({ description: 'Points that expire within the window', example: 50 })
  points: number;

  @ApiProperty({ type: PointsNearestExpiryDto, nullable: true })
  nearest: PointsNearestExpiryDto | null;
}

export class PendingModerationDto {
  @ApiProperty({ description: 'Receipts waiting for a moderator', example: 1 })
  count: number;

  @ApiProperty({ description: 'Points they would bring when approved', example: 180 })
  expectedPoints: number;
}

export class ClubAccountDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null until the account is created after registration',
  })
  accountId: string | null;

  @ApiProperty({
    description: 'Available points; negative after a reversal, spending is then blocked',
    example: 320,
  })
  balance: number;

  @ApiProperty({ description: 'Held points waiting for release (large receipts)', example: 0 })
  pending: number;

  @ApiProperty({ example: 380 })
  lifetimeEarned: number;

  @ApiProperty({ description: '9-digit member code printed on the card', example: '734211800' })
  memberCode: string;

  @ApiProperty({
    description: 'Club card QR payload PC1:<memberCode>:<hmac8>',
    example: 'PC1:734211800:1a2b3c4d',
  })
  qrPayload: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Spending is locked for new members until this moment',
  })
  newcomerLockUntil: string | null;

  @ApiProperty({
    enum: SPEND_BLOCK_REASONS,
    nullable: true,
    description: 'Why spending is blocked right now; null when it is allowed',
  })
  spendBlockedBy: SpendBlockReason | null;

  @ApiProperty({ type: PointsExpiringSoonDto })
  expiringSoon: PointsExpiringSoonDto;

  @ApiProperty({ description: 'Value of one point in kopecks', example: 100 })
  pointValueKopecks: number;

  @ApiProperty({
    type: PendingModerationDto,
    description: 'Receipts on moderation; zeros when the receipts module cannot answer',
  })
  pendingModeration: PendingModerationDto;
}

export function toClubAccountDto(view: ClubAccountView): ClubAccountDto {
  return {
    accountId: view.accountId,
    balance: view.balance,
    pending: view.pending,
    lifetimeEarned: view.lifetimeEarned,
    memberCode: view.memberCode,
    qrPayload: view.qrPayload,
    newcomerLockUntil: isoOrNull(view.newcomerLockUntil),
    spendBlockedBy: view.spendBlockedBy,
    expiringSoon: {
      withinDays: view.expiringSoon.withinDays,
      points: view.expiringSoon.points,
      nearest: view.expiringSoon.nearest ? { ...view.expiringSoon.nearest } : null,
    },
    pointValueKopecks: view.pointValueKopecks,
    pendingModeration: {
      count: view.pendingModeration.count,
      expectedPoints: view.pendingModeration.expectedPoints,
    },
  };
}
