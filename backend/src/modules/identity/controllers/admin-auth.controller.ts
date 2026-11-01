import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  AdminLoginDto,
  AdminLoginResponseDto,
  AdminTotpConfirmDto,
  AdminTotpDisableDto,
  AdminTotpDto,
  AdminTotpEnrollConfirmDto,
  AdminTotpEnrollDto,
  AdminTotpSetupResponseDto,
} from '../dto/admin.dto';
import { AdminUserDto } from '../dto/common.dto';
import { AdminAuthService } from '../services/admin-auth.service';
import { clientIp } from './params';

/**
 * Per IP (network) on top of the per-account lockout, the audited failures and the scrypt
 * semaphore (429 PC_ADMIN_LOGIN_BUSY beyond its queue).
 */
const ADMIN_LOGIN_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/** Back-office login: e-mail + password, optional TOTP second factor (brief sections 3 and 8). */
@ApiTags('admin')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle(ADMIN_LOGIN_THROTTLE)
  @ApiOperation({
    summary: 'Admin login with e-mail and password (and TOTP code if enabled)',
    description:
      'When TOTP is enabled and no code was sent, answers 401 PC_ADMIN_TOTP_REQUIRED with details.challengeToken (single use, 5 attempts, valid 5 minutes) for POST /admin/auth/totp. Roles in ADMIN_REQUIRE_TOTP_ROLES (owner, manager) without TOTP get 403 PC_ADMIN_TOTP_SETUP_REQUIRED with details.enrollmentToken for POST /admin/auth/totp/enroll. 401 PC_ADMIN_CREDENTIALS_INVALID never tells whether the e-mail exists. 5 failed logins lock the account with exponential backoff (429 PC_ADMIN_LOGIN_LOCKED, details.retryAfterSeconds); 429 PC_ADMIN_LOGIN_BUSY when too many password checks run at once.',
  })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @ApiProblemResponses(400, 401, 403, 429)
  async login(
    @Body() body: AdminLoginDto,
    @Ip() ip: string | undefined,
  ): Promise<AdminLoginResponseDto> {
    return this.adminAuth.login({
      email: body.email,
      password: body.password,
      ...(body.code ? { code: body.code } : {}),
      ip: clientIp(ip),
    });
  }

  @Post('totp')
  @HttpCode(200)
  @Throttle(ADMIN_LOGIN_THROTTLE)
  @ApiOperation({
    summary: 'Second login step: challenge token + TOTP code -> admin access token',
    description:
      'The challenge is single use and accepts at most 5 codes (401 PC_ADMIN_TOTP_INVALID carries details.attemptsLeft); afterwards 401 PC_ADMIN_CHALLENGE_INVALID asks for a new login.',
  })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @ApiProblemResponses(400, 401, 403, 429)
  async totp(
    @Body() body: AdminTotpDto,
    @Ip() ip: string | undefined,
  ): Promise<AdminLoginResponseDto> {
    return this.adminAuth.completeTotp(body.challengeToken, body.code, clientIp(ip));
  }

  @Post('totp/enroll')
  @HttpCode(200)
  @Throttle(ADMIN_LOGIN_THROTTLE)
  @ApiOperation({
    summary: 'Mandatory TOTP enrollment at login, step 1: enrollment token -> new secret',
    description:
      'Public (the enrollment token from 403 PC_ADMIN_TOTP_SETUP_REQUIRED proves the password). Returns the secret, the otpauth URI for the QR code and a setup token for POST /admin/auth/totp/enroll/confirm.',
  })
  @ApiOkResponse({ type: AdminTotpSetupResponseDto })
  @ApiProblemResponses(400, 401, 403, 409, 429)
  async enrollTotp(@Body() body: AdminTotpEnrollDto): Promise<AdminTotpSetupResponseDto> {
    return this.adminAuth.startTotpEnrollment(body.enrollmentToken);
  }

  @Post('totp/enroll/confirm')
  @HttpCode(200)
  @Throttle(ADMIN_LOGIN_THROTTLE)
  @ApiOperation({
    summary: 'Mandatory TOTP enrollment at login, step 2: first code -> TOTP enabled + admin token',
  })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @ApiProblemResponses(400, 401, 403, 409, 429)
  async confirmTotpEnrollment(
    @Body() body: AdminTotpEnrollConfirmDto,
    @Ip() ip: string | undefined,
  ): Promise<AdminLoginResponseDto> {
    return this.adminAuth.confirmTotpEnrollment(body.setupToken, body.code, clientIp(ip));
  }

  @Get('me')
  @Auth('admin')
  @ApiOperation({ summary: 'The admin account of the access token' })
  @ApiOkResponse({ type: AdminUserDto })
  @ApiProblemResponses(404)
  async me(@CurrentUser('id') adminId: string): Promise<AdminUserDto> {
    return this.adminAuth.getMe(adminId);
  }

  @Post('totp/setup')
  @HttpCode(200)
  @Auth('admin')
  @ApiOperation({
    summary: 'Start enabling TOTP: new secret, otpauth URI and a setup token (10 minutes)',
  })
  @ApiOkResponse({ type: AdminTotpSetupResponseDto })
  @ApiProblemResponses(404, 409)
  async setupTotp(@CurrentUser('id') adminId: string): Promise<AdminTotpSetupResponseDto> {
    return this.adminAuth.setupTotp(adminId);
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @Auth('admin')
  @ApiOperation({ summary: 'Finish enabling TOTP with the first code from the app' })
  @ApiOkResponse({ type: AdminUserDto })
  @ApiProblemResponses(400, 401, 404, 409)
  async confirmTotp(
    @CurrentUser('id') adminId: string,
    @Body() body: AdminTotpConfirmDto,
    @Ip() ip: string | undefined,
  ): Promise<AdminUserDto> {
    return this.adminAuth.confirmTotp(adminId, body.setupToken, body.code, clientIp(ip));
  }

  @Post('totp/disable')
  @HttpCode(200)
  @Auth('admin')
  @ApiOperation({
    summary: 'Disable TOTP (requires a current code)',
    description:
      'Refused with 409 PC_ADMIN_TOTP_REQUIRED_FOR_ROLE for roles in ADMIN_REQUIRE_TOTP_ROLES.',
  })
  @ApiOkResponse({ type: AdminUserDto })
  @ApiProblemResponses(400, 401, 404, 409)
  async disableTotp(
    @CurrentUser('id') adminId: string,
    @Body() body: AdminTotpDisableDto,
    @Ip() ip: string | undefined,
  ): Promise<AdminUserDto> {
    return this.adminAuth.disableTotp(adminId, body.code, clientIp(ip));
  }
}
