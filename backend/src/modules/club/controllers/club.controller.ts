import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, Public } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { ClubAccountDto, toClubAccountDto } from '../dto/club-account.dto';
import { PublicLoyaltyRulesDto, toPublicRulesDto } from '../dto/rules.dto';
import {
  ListPointsTransactionsQueryDto,
  PointsTransactionPageDto,
  PointsTransactionsSummaryDto,
  TransactionsSummaryQueryDto,
  toTransactionPageDto,
  toTransactionsSummaryDto,
} from '../dto/transactions.dto';
import { ClubAccountService } from '../services/club-account.service';
import { RuleSetsService } from '../services/rule-sets.service';

/**
 * Member endpoints of the club (brief section 8): the card tab and the points history, plus the
 * public rules. `@Auth('member')` sits on each member handler rather than on the class, so the
 * public `GET /club/rules` carries no bearer security requirement in OpenAPI either.
 */
@ApiTags('club')
@Controller('club')
export class ClubController {
  constructor(
    private readonly accounts: ClubAccountService,
    private readonly ruleSets: RuleSetsService,
  ) {}

  @Get('account')
  @Auth('member')
  @ApiOperation({
    summary: 'My club card: balance, pending points, member code, QR payload, newcomer lock',
    description:
      'qrPayload is PC1:<memberCode>:<hmac8>. expiringSoon covers the largest reminder window (30 days by default). pendingModeration counts receipts waiting for a moderator and the points they would bring.',
  })
  @ApiOkResponse({ type: ClubAccountDto })
  @ApiProblemResponses(404)
  async account(@CurrentUser('id') userId: string): Promise<ClubAccountDto> {
    return toClubAccountDto(await this.accounts.getAccountView(userId));
  }

  @Get('transactions')
  @Auth('member')
  @ApiOperation({
    summary: 'My points history, newest first (cursor pagination)',
    description:
      'Optional window: from (inclusive) and to (exclusive), ISO date-time. Each row carries title, subtitle and counterparty for display.',
  })
  @ApiOkResponse({ type: PointsTransactionPageDto })
  @ApiProblemResponses(400)
  async transactions(
    @CurrentUser('id') userId: string,
    @Query() query: ListPointsTransactionsQueryDto,
  ): Promise<PointsTransactionPageDto> {
    const page = await this.accounts.listTransactions(userId, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
      ...(query.type ? { type: query.type } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    });
    return toTransactionPageDto(page);
  }

  @Get('transactions/summary')
  @Auth('member')
  @ApiOperation({
    summary: 'Points earned, spent and expired in a Kyiv calendar month',
    description: 'month=YYYY-MM, default the current month (Europe/Kyiv). All totals are positive.',
  })
  @ApiOkResponse({ type: PointsTransactionsSummaryDto })
  @ApiProblemResponses(400)
  async summary(
    @CurrentUser('id') userId: string,
    @Query() query: TransactionsSummaryQueryDto,
  ): Promise<PointsTransactionsSummaryDto> {
    return toTransactionsSummaryDto(
      await this.accounts.getTransactionsSummary(userId, query.month),
    );
  }

  @Get('rules')
  @Public()
  @ApiOperation({
    summary: 'Public program rules in force (earn rate, caps, expiry, welcome bonuses)',
  })
  @ApiOkResponse({ type: PublicLoyaltyRulesDto })
  async rules(): Promise<PublicLoyaltyRulesDto> {
    return toPublicRulesDto(await this.ruleSets.getActiveRules());
  }
}
