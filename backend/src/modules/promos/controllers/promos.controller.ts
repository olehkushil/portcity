import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser, OptionalAuth } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import { ListPromosQueryDto } from '../dto/promo-query.dto';
import { ClaimResultDto, PromoDetailDto, PromoPageDto } from '../dto/promo.dto';
import { PromosService } from '../services/promos.service';

@ApiTags('promos')
@Controller('promos')
@Auth('member')
export class PromosController {
  constructor(private readonly promos: PromosService) {}

  @Get()
  @OptionalAuth()
  @ApiOperation({
    summary: 'Published promos inside their validity window (guest-readable)',
    description: 'Works without a token; filter by tenant, kind and category.',
  })
  @ApiOkResponse({ type: PromoPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: ListPromosQueryDto): Promise<PromoPageDto> {
    return this.promos.listPublished(query);
  }

  @Get(':id')
  @OptionalAuth()
  @ApiOperation({
    summary: 'Promo detail with the claim state of the caller (guest-readable)',
    description:
      'Without a token the claim state is { allowed: false, code: PC_AUTH_REQUIRED }; with a member token it reflects the member limits.',
  })
  @ApiOkResponse({ type: PromoDetailDto })
  @ApiProblemResponses(400, 404)
  get(
    @Param('id', ParseUUIDPipe) promoId: string,
    @CurrentUser('id') userId: string | undefined,
  ): Promise<PromoDetailDto> {
    return this.promos.getPublishedForMember(promoId, userId);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Claim a coupon of the promo',
    description:
      'Issues a coupon voucher (kind = coupon) through the rewards module. Limited per member and per pool; requires Idempotency-Key.',
  })
  @ApiCreatedResponse({ type: ClaimResultDto })
  @ApiProblemResponses(400, 404, 409, 422, 429)
  claim(
    @Param('id', ParseUUIDPipe) promoId: string,
    @CurrentUser('id') userId: string,
  ): Promise<ClaimResultDto> {
    return this.promos.claim(promoId, userId);
  }
}
