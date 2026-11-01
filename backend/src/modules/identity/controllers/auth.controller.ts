import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  LogoutDto,
  LogoutResponseDto,
  OtpRequestDto,
  OtpRequestResponseDto,
  OtpVerifyDto,
  OtpVerifyResponseDto,
  RefreshDto,
  RefreshResponseDto,
} from '../dto/auth.dto';
import { AuthService } from '../services/auth.service';
import { toUserDto } from '../services/mappers';
import { SessionService, toSessionTokensDto } from '../services/session.service';
import { clientIp } from './params';

/** Throttler guard on top of the database counters: 10 code requests per IP per hour (brief section 8). */
const OTP_REQUEST_THROTTLE = { default: { limit: 10, ttl: 3_600_000 } };
/** Brute force is already bounded by 5 attempts per code; this only caps floods per IP. */
const OTP_VERIFY_THROTTLE = { default: { limit: 30, ttl: 600_000 } };

/** Member login by SMS code and session tokens (brief section 8, "auth"). */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('otp/request')
  @HttpCode(200)
  @Throttle(OTP_REQUEST_THROTTLE)
  @ApiOperation({
    summary: 'Send a 6-digit login code by SMS',
    description:
      'Public. Limits: one code per 60 s (resendAvailableAt), 3 per phone per 10 minutes, 5 per phone per 24 hours and 10 per IP network per hour, IPv6 counted per /64 (429 PC_OTP_RATE_LIMITED, details.scope cooldown|phone|phone_daily|ip and retryAfterSeconds). 10 wrong codes per phone in 24 hours lock the phone (429 PC_OTP_LOCKED). Above soft thresholds 403 PC_OTP_CAPTCHA_REQUIRED asks for captchaToken; 503 PC_OTP_SMS_BUDGET_EXHAUSTED when the daily SMS budget is used up. The code lives 5 minutes and allows 5 attempts; a new request voids the previous code.',
  })
  @ApiOkResponse({ type: OtpRequestResponseDto })
  @ApiProblemResponses(400, 403, 429, 503)
  async requestOtp(
    @Body() body: OtpRequestDto,
    @Ip() ip: string | undefined,
  ): Promise<OtpRequestResponseDto> {
    return this.auth.requestOtp({
      phone: body.phone,
      ip: clientIp(ip),
      fingerprint: body.fingerprint ?? null,
      captchaToken: body.captchaToken ?? null,
    });
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Throttle(OTP_VERIFY_THROTTLE)
  @ApiOperation({
    summary: 'Exchange the SMS code for tokens; creates the member on first login',
    description:
      'Returns an access token (15 min) and an opaque refresh token (60 days, single use). 401 PC_OTP_INVALID carries details.attemptsLeft; 401 PC_OTP_EXPIRED and 429 PC_OTP_TOO_MANY_ATTEMPTS ask for a new code; 429 PC_OTP_LOCKED after 10 wrong codes for the phone in 24 hours; 403 PC_USER_BLOCKED for blocked members. Consents granted without a version accept the current text of GET /legal/documents. A new member triggers user.registered (club opens the account and the welcome bonus).',
  })
  @ApiOkResponse({ type: OtpVerifyResponseDto })
  @ApiProblemResponses(400, 401, 403, 422, 429)
  async verifyOtp(@Body() body: OtpVerifyDto): Promise<OtpVerifyResponseDto> {
    return this.auth.verifyOtp({
      phone: body.phone,
      code: body.code,
      device: body.device,
      ...(body.consents ? { consents: body.consents } : {}),
    });
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate the refresh token and get a new access token',
    description:
      'Every call returns a new refresh token; the old one stops working. Presenting a rotated token again revokes every token of that login (401 PC_REFRESH_REUSED).',
  })
  @ApiOkResponse({ type: RefreshResponseDto })
  @ApiProblemResponses(400, 401, 403, 410)
  async refresh(@Body() body: RefreshDto): Promise<RefreshResponseDto> {
    const { session, user } = await this.sessions.refresh(body.refreshToken);
    return { ...toSessionTokensDto(session), user: toUserDto(user), deviceId: session.deviceId };
  }

  @Post('logout')
  @HttpCode(200)
  @Auth('member')
  @ApiOperation({
    summary: 'End sessions: this device (default), one login (refreshToken) or all devices',
    description:
      'Revokes refresh tokens and removes push tokens of the affected devices. Access tokens already issued expire on their own (15 min).',
  })
  @ApiOkResponse({ type: LogoutResponseDto })
  @ApiProblemResponses(400)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LogoutDto,
  ): Promise<LogoutResponseDto> {
    const revokedSessions = await this.sessions.logout(user.id, user.deviceId, {
      ...(body.refreshToken ? { refreshToken: body.refreshToken } : {}),
      ...(body.allDevices ? { allDevices: true } : {}),
    });
    return { revokedSessions };
  }
}
