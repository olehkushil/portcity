import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser, OptionalAuth } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import {
  RedeemRewardResponseDto,
  RewardDto,
  RewardListQueryDto,
  RewardPageDto,
} from '../dto/reward.dto';
import { RedemptionService, toRedeemRewardResponse } from '../services/redemption.service';
import { RewardsCatalogueService } from '../services/rewards-catalogue.service';
import { uuidParam } from './uuid.pipe';

/**
 * Reward catalogue and the exchange of points for a reward (brief section 8). The catalogue is
 * guest-readable (product decision): without a token the per-user fields are null; redeeming
 * needs a member token.
 */
@ApiTags('rewards')
@Controller('rewards')
export class RewardsController {
  constructor(
    private readonly catalogue: RewardsCatalogueService,
    private readonly redemptions: RedemptionService,
  ) {}

  @Get()
  @OptionalAuth()
  @ApiOperation({
    summary: 'Reward catalogue (active rewards inside their validity period); guest-readable',
    description:
      'Each item carries `affordable` (against the current balance), `available` and `remainingForUser`. `affordable=true` keeps only rewards the member can pay for now. Without a token (guest) `affordable` and `remainingForUser` are null and `affordable=true` is ignored; an invalid token still yields 401.',
  })
  @ApiOkResponse({ type: RewardPageDto })
  @ApiProblemResponses(400, 401)
  list(
    @CurrentUser('id') userId: string | undefined,
    @Query() query: RewardListQueryDto,
  ): Promise<RewardPageDto> {
    return this.catalogue.listForMember(userId, {
      affordable: query.affordable,
      kind: query.kind,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':id')
  @OptionalAuth()
  @ApiOperation({
    summary: 'Reward detail with affordability and the per-member limit; guest-readable',
    description: 'Without a token `affordable` and `remainingForUser` are null.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RewardDto })
  @ApiProblemResponses(400, 401, 404)
  get(
    @CurrentUser('id') userId: string | undefined,
    @Param('id', uuidParam()) rewardId: string,
  ): Promise<RewardDto> {
    return this.catalogue.getForMember(userId, rewardId);
  }

  @Post(':id/redeem')
  @Auth('member')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Exchange points for the reward',
    description:
      'One transaction: checks period, stock and the per-member limit, spends the points through the club ledger and issues a voucher (status issued). Requires Idempotency-Key.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: RedeemRewardResponseDto })
  @ApiProblemResponses(400, 404, 409, 422, 429)
  async redeem(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) rewardId: string,
  ): Promise<RedeemRewardResponseDto> {
    return toRedeemRewardResponse(await this.redemptions.redeem(userId, rewardId));
  }
}
