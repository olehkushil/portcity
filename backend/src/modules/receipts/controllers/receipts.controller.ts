import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { Idempotent } from '../../../common/idempotency/idempotency.decorator';
import {
  CreateAppealDto,
  CreatePhotoUploadUrlDto,
  ListReceiptsQueryDto,
  SubmitManualDto,
  SubmitQrDto,
} from '../dto/receipt-requests.dto';
import {
  PhotoUploadUrlDto,
  ReceiptDetailDto,
  ReceiptPageDto,
  ReceiptSubmissionResultDto,
} from '../dto/receipt-responses.dto';
import {
  type MemberContext,
  ReceiptSubmissionService,
} from '../services/receipt-submission.service';

function memberOf(user: AuthenticatedUser): MemberContext {
  return { userId: user.id, deviceId: user.deviceId ?? null };
}

/** Member endpoints: submit receipts, upload photos, history, appeals (brief section 8). */
@ApiTags('receipts')
@Controller('receipts')
@Auth('member')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptSubmissionService) {}

  @Post('qr')
  @Idempotent()
  @Throttle({ default: { limit: 30, ttl: 600_000 } })
  @ApiOperation({
    summary: 'Submit a fiscal receipt by its QR code',
    description:
      'Parses the tax-service URL, checks duplicates and the risk rules, and credits points at once when the receipt is auto-approved. `screen` tells the app which result to show: credited, pending (moderation) or rejected (with `rejectionCode` and a Ukrainian `message`).',
  })
  @ApiCreatedResponse({ type: ReceiptSubmissionResultDto })
  @ApiProblemResponses(400, 409, 422, 429)
  submitQr(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SubmitQrDto,
  ): Promise<ReceiptSubmissionResultDto> {
    return this.receipts.submitQr(memberOf(user), body.qrText);
  }

  @Post('manual')
  @Idempotent()
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @ApiOperation({
    summary: 'Submit a receipt without a QR code (photo required, always moderated)',
    description:
      'Requires an Idempotency-Key. Upload the photo first with POST /receipts/photo-upload-url and pass the returned key as photoKey. tenantId is the shop picked on the form (null = "Не знаю"); fn may be omitted when tenantId is given (the moderator fills it in). Disabled by the feature flag receipts.manual_submission (403 PC_RECEIPT_MANUAL_DISABLED).',
  })
  @ApiCreatedResponse({ type: ReceiptSubmissionResultDto })
  @ApiProblemResponses(400, 403, 409, 422, 429)
  submitManual(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SubmitManualDto,
  ): Promise<ReceiptSubmissionResultDto> {
    return this.receipts.submitManual(memberOf(user), body);
  }

  @Post('photo-upload-url')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @ApiOperation({
    summary: 'Presigned PUT for a receipt photo (JPEG, PNG or HEIC, up to 5 MB)',
    description: 'The key is scoped to the member and can only be attached to their own receipts.',
  })
  @ApiOkResponse({ type: PhotoUploadUrlDto })
  @ApiProblemResponses(400, 422, 429)
  createPhotoUploadUrl(
    @CurrentUser('id') userId: string,
    @Body() body: CreatePhotoUploadUrlDto,
  ): Promise<PhotoUploadUrlDto> {
    return this.receipts.createPhotoUploadUrl(userId, body);
  }

  @Get()
  @ApiOperation({
    summary: 'My receipts, newest first (cursor pagination)',
    description:
      'Filters: status, from/to (submittedAt, ISO 8601). Receipts in moderation or processing carry expectedPoints.',
  })
  @ApiOkResponse({ type: ReceiptPageDto })
  @ApiProblemResponses(400)
  list(
    @CurrentUser('id') userId: string,
    @Query() query: ListReceiptsQueryDto,
  ): Promise<ReceiptPageDto> {
    return this.receipts.list(userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my receipts with points, history, appeals and photo link' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ReceiptDetailDto })
  @ApiProblemResponses(400, 404)
  get(
    @CurrentUser('id') userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReceiptDetailDto> {
    return this.receipts.get(userId, id);
  }

  @Post(':id/appeal')
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @ApiOperation({
    summary: 'Appeal a rejected receipt (once); a moderator reviews it within 24 h',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ReceiptDetailDto })
  @ApiProblemResponses(400, 404, 409, 422, 429)
  appeal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateAppealDto,
  ): Promise<ReceiptDetailDto> {
    return this.receipts.appeal(memberOf(user), id, body);
  }
}
