import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import { CurrentValidator, ValidatorAuth } from '../auth/validator.decorators';
import {
  OpenShiftDto,
  OpenShiftResponseDto,
  ValidatorDeviceSelfDto,
  ValidatorLogPageDto,
  ValidatorRedeemDto,
  ValidatorRedeemResponseDto,
} from '../dto/validator.dto';
import { toValidatorLogPageDto } from '../services/validator.mapper';
import { type ValidatorPrincipal, ValidatorService } from '../services/validator.service';

/**
 * Cashier validator API (brief section 8): the device authenticates with X-Validator-Key, the
 * cashier enters the shift PIN once (POST /validator/shift) and then sends the shift token as
 * X-Validator-Shift. Redemption is atomic and every attempt lands in the device log.
 */
@ApiTags('validator')
@Controller('validator')
export class ValidatorController {
  constructor(private readonly validators: ValidatorService) {}

  @Post('shift')
  @HttpCode(HttpStatus.OK)
  @ValidatorAuth({ shift: false })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Open a shift with the PIN',
    description:
      'Requires only X-Validator-Key; the only endpoint that accepts the PIN. Returns a shift token valid for VALIDATOR_SHIFT_HOURS; changing the PIN or revoking the device closes every open shift. 5 wrong PINs in a row lock this endpoint for the device for 15 minutes (429 PC_VALIDATOR_PIN_LOCKED, audited).',
  })
  @ApiOkResponse({ type: OpenShiftResponseDto })
  @ApiProblemResponses(400, 429)
  openShift(
    @CurrentValidator() principal: ValidatorPrincipal,
    @Body() body: OpenShiftDto,
    @Ip() ip: string,
  ): Promise<OpenShiftResponseDto> {
    return this.validators.openShift(principal.deviceId, body.pin, ip || null);
  }

  @Get('me')
  @ValidatorAuth()
  @ApiOperation({ summary: 'The authenticated device and the current shift' })
  @ApiOkResponse({ type: ValidatorDeviceSelfDto })
  me(@CurrentValidator() principal: ValidatorPrincipal): Promise<ValidatorDeviceSelfDto> {
    return this.validators.describe(principal);
  }

  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  @ValidatorAuth()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Redeem a voucher by code, by the scanned activation token or by a static ticket QR',
    description:
      "Activation code/token: atomic `UPDATE ... WHERE status = active AND activation_expires_at > now`. Static QR (PCV1:..., tickets and certificates): valid until the voucher expiresAt, single use, no activation needed. A tenant device redeems only vouchers of its tenant; a mall device (tenantId null) redeems any. Failures are logged and answered with PC_VOUCHER_* problems that carry no voucher id; another tenant's voucher only ever reads as PC_VOUCHER_WRONG_TENANT.",
  })
  @ApiOkResponse({ type: ValidatorRedeemResponseDto })
  @ApiProblemResponses(400, 404, 409, 422, 429)
  redeem(
    @CurrentValidator() principal: ValidatorPrincipal,
    @Body() body: ValidatorRedeemDto,
    @Ip() ip: string,
  ): Promise<ValidatorRedeemResponseDto> {
    return this.validators.redeem(principal, { code: body.code, token: body.token }, ip || null);
  }

  @Get('log')
  @ValidatorAuth()
  @ApiOperation({ summary: 'Redeem attempts of this device, newest first' })
  @ApiOkResponse({ type: ValidatorLogPageDto })
  @ApiProblemResponses(400)
  async log(
    @CurrentValidator() principal: ValidatorPrincipal,
    @Query() query: CursorQueryDto,
  ): Promise<ValidatorLogPageDto> {
    return toValidatorLogPageDto(
      await this.validators.listLog(principal.deviceId, query.cursor, query.limit),
      { forDevice: true },
    );
  }
}
