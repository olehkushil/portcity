import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { SUPPORT_REQUESTS_PER_DAY } from '../../../common/contracts/admin';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import {
  CreateSupportRequestDto,
  SupportPhotoUploadDto,
  SupportPhotoUploadRequestDto,
  SupportRequestCreatedDto,
  SupportRequestPageDto,
} from '../dto/support.dto';
import { SupportRequestsService } from '../services/support-requests.service';

/** Member side of support requests ("Звернення"): create, list own, photo upload link. */
@ApiTags('support')
@Controller('support/requests')
@Auth('member')
export class SupportController {
  constructor(private readonly support: SupportRequestsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Send a support request',
    description: `Topic receipt | parking | voucher | other, optional related object and photo. At most ${SUPPORT_REQUESTS_PER_DAY} requests per member per Kyiv day (429 PC_SUPPORT_REQUEST_DAILY_LIMIT). Returns the human number for "Звернення № N прийнято"; support gets an e-mail and the member an in-app confirmation. Requires Idempotency-Key.`,
  })
  @ApiCreatedResponse({ type: SupportRequestCreatedDto })
  @ApiProblemResponses(400, 409, 422, 429)
  create(
    @CurrentUser('id') userId: string,
    @Body() body: CreateSupportRequestDto,
  ): Promise<SupportRequestCreatedDto> {
    return this.support.create(userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'My support requests, newest first' })
  @ApiOkResponse({ type: SupportRequestPageDto })
  @ApiProblemResponses(400)
  list(
    @CurrentUser('id') userId: string,
    @Query() query: CursorQueryDto,
  ): Promise<SupportRequestPageDto> {
    return this.support.listMine(userId, { cursor: query.cursor, limit: query.limit });
  }

  @Post('photo-upload-url')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Presigned PUT for a support photo',
    description:
      'Upload the photo with the returned URL and headers, then pass `key` as photoKey. JPEG, PNG, WEBP or HEIC up to 5 MB.',
  })
  @ApiOkResponse({ type: SupportPhotoUploadDto })
  @ApiProblemResponses(400, 422, 429)
  photoUploadUrl(
    @CurrentUser('id') userId: string,
    @Body() body: SupportPhotoUploadRequestDto,
  ): Promise<SupportPhotoUploadDto> {
    return this.support.createPhotoUpload(userId, body);
  }
}
