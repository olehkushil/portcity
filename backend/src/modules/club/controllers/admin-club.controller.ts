import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { AdminClubAccountDto, toAdminClubAccountDto } from '../dto/admin-account.dto';
import {
  CreateLoyaltyRuleSetDto,
  DeleteLoyaltyRuleSetQueryDto,
  LoyaltyRuleSetDto,
  UpdateLoyaltyRuleSetDto,
  toRuleSetDto,
  toRulesPatch,
} from '../dto/rules.dto';
import {
  AdminPointsTransactionPageDto,
  ListPointsTransactionsQueryDto,
  toAdminTransactionPageDto,
} from '../dto/transactions.dto';
import { ClubAccountService } from '../services/club-account.service';
import { RuleSetsService } from '../services/rule-sets.service';
import { uuidParam } from './uuid.pipe';

/**
 * Versioned loyalty rule sets (`/admin/club/rule-sets`). Reading is open to the back office;
 * creating or editing a version is for owner and manager. A version in force is immutable:
 * changes are a new version (optionally scheduled with a future `activeFrom`). Every mutation
 * is audited by RuleSetsService through ADMIN_AUDIT_PORT.
 */
@ApiTags('admin')
@Controller('admin/club/rule-sets')
@Auth('admin', 'owner', 'manager', 'support', 'moderator')
export class AdminRuleSetsController {
  constructor(private readonly ruleSets: RuleSetsService) {}

  @Get()
  @ApiOperation({ summary: 'All rule set versions, newest first; `active` marks the one in force' })
  @ApiOkResponse({ type: [LoyaltyRuleSetDto] })
  async list(): Promise<LoyaltyRuleSetDto[]> {
    return (await this.ruleSets.list()).map(toRuleSetDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One rule set version' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LoyaltyRuleSetDto })
  @ApiProblemResponses(400, 404)
  async get(@Param('id', uuidParam()) id: string): Promise<LoyaltyRuleSetDto> {
    return toRuleSetDto(await this.ruleSets.getById(id));
  }

  @Post()
  @Roles('owner', 'manager')
  @ApiOperation({
    summary: 'Create a new rule set version',
    description:
      'config is a partial patch merged over the rules in force at activeFrom (defaults: now, next version). activeFrom may not be in the past.',
  })
  @ApiCreatedResponse({ type: LoyaltyRuleSetDto })
  @ApiProblemResponses(400, 409)
  async create(
    @Body() body: CreateLoyaltyRuleSetDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<LoyaltyRuleSetDto> {
    const config = toRulesPatch(body.config);
    const view = await this.ruleSets.create(
      {
        ...(body.version !== undefined ? { version: body.version } : {}),
        ...(body.activeFrom !== undefined ? { activeFrom: new Date(body.activeFrom) } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
      { adminId: admin.id, ip },
    );
    return toRuleSetDto(view);
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Edit a version that is scheduled for the future' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LoyaltyRuleSetDto })
  @ApiProblemResponses(400, 404, 409)
  async update(
    @Param('id', uuidParam()) id: string,
    @Body() body: UpdateLoyaltyRuleSetDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<LoyaltyRuleSetDto> {
    const config = toRulesPatch(body.config);
    const view = await this.ruleSets.update(
      id,
      {
        ...(body.activeFrom !== undefined ? { activeFrom: new Date(body.activeFrom) } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
      { adminId: admin.id, ip },
    );
    return toRuleSetDto(view);
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a version that is scheduled for the future' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404, 409)
  async remove(
    @Param('id', uuidParam()) id: string,
    @Query() query: DeleteLoyaltyRuleSetQueryDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<void> {
    await this.ruleSets.remove(id, { adminId: admin.id, ip }, query.reason);
  }
}

/** Read-only member account views for the back office (`/admin/club/accounts/:userId`). */
@ApiTags('admin')
@Controller('admin/club/accounts')
@Auth('admin', 'owner', 'manager', 'support', 'moderator')
export class AdminClubAccountsController {
  constructor(private readonly accounts: ClubAccountService) {}

  @Get(':userId')
  @ApiOperation({
    summary: 'Member loyalty account: balances, newcomer lock, welcome flags, buckets',
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: AdminClubAccountDto })
  @ApiProblemResponses(400, 404)
  async account(
    @Param('userId', uuidParam('userId')) userId: string,
  ): Promise<AdminClubAccountDto> {
    return toAdminClubAccountDto(await this.accounts.getAdminAccountView(userId));
  }

  @Get(':userId/transactions')
  @ApiOperation({ summary: 'Member points ledger with idempotency keys, newest first' })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: AdminPointsTransactionPageDto })
  @ApiProblemResponses(400)
  async transactions(
    @Param('userId', uuidParam('userId')) userId: string,
    @Query() query: ListPointsTransactionsQueryDto,
  ): Promise<AdminPointsTransactionPageDto> {
    const page = await this.accounts.listTransactions(userId, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
      ...(query.type ? { type: query.type } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    });
    return toAdminTransactionPageDto(page);
  }
}
