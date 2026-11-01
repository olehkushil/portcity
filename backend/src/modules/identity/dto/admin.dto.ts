import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { ADMIN_ROLES, type AdminRole } from '../../../common/auth/auth.types';
import { USER_STATUSES, type UserStatus } from '../../../common/contracts/identity';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto';
import {
  AdminUserDto,
  ConsentStateDto,
  DeletionRequestDto,
  DeviceDto,
  UserDto,
} from './common.dto';

const TOTP_CODE_MESSAGE = 'code must be 6 digits';

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@portcity.local' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 8, maxLength: 200 })
  @IsString()
  @Length(8, 200)
  password: string;

  @ApiPropertyOptional({
    example: '123456',
    description: 'TOTP code; may be sent together with the password to skip the challenge step',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: TOTP_CODE_MESSAGE })
  code?: string;
}

export class AdminLoginResponseDto {
  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({ description: 'Admin access JWT (no refresh token; see README)' })
  accessToken: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ type: AdminUserDto })
  admin: AdminUserDto;
}

export class AdminTotpDto {
  @ApiProperty({ description: '`details.challengeToken` of the PC_ADMIN_TOTP_REQUIRED response' })
  @IsString()
  @Length(20, 2048)
  challengeToken: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: TOTP_CODE_MESSAGE })
  code: string;
}

export class AdminTotpEnrollDto {
  @ApiProperty({
    description: '`details.enrollmentToken` of the PC_ADMIN_TOTP_SETUP_REQUIRED login response',
  })
  @IsString()
  @Length(20, 2048)
  enrollmentToken: string;
}

export class AdminTotpEnrollConfirmDto {
  @ApiProperty({ description: '`setupToken` returned by POST /admin/auth/totp/enroll' })
  @IsString()
  @Length(20, 2048)
  setupToken: string;

  @ApiProperty({ example: '123456', description: 'First code shown by the authenticator app' })
  @IsString()
  @Matches(/^\d{6}$/, { message: TOTP_CODE_MESSAGE })
  code: string;
}

export class AdminTotpSetupResponseDto {
  @ApiProperty({ description: 'Base32 secret to type into the authenticator app' })
  secret: string;

  @ApiProperty({ description: 'otpauth:// URI for the QR code' })
  otpauthUri: string;

  @ApiProperty({ description: 'Pass back to totp/confirm together with the first code' })
  setupToken: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

export class AdminTotpConfirmDto {
  @ApiProperty()
  @IsString()
  @Length(20, 2048)
  setupToken: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: TOTP_CODE_MESSAGE })
  code: string;
}

export class AdminTotpDisableDto {
  @ApiProperty({ example: '123456', description: 'Current code, proves possession of the device' })
  @IsString()
  @Matches(/^\d{6}$/, { message: TOTP_CODE_MESSAGE })
  code: string;
}

export class AdminUsersQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({
    description: 'Phone (any notation), member code, e-mail or part of the name',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;
}

/** Member as seen in the back office: same fields as UserDto, the phone is masked. */
export class AdminMemberDto extends OmitType(UserDto, ['phone'] as const) {
  @ApiProperty({
    example: '+380 50 *** ** 67',
    description: 'Masked phone; anonymised accounts show their `anon:` placeholder',
  })
  phone: string;
}

export class AdminUserPageDto {
  @ApiProperty({ type: [AdminMemberDto] })
  items: AdminMemberDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;
}

export class AdminUserDetailsDto {
  @ApiProperty({ type: AdminMemberDto })
  user: AdminMemberDto;

  @ApiProperty({ type: [DeviceDto] })
  devices: DeviceDto[];

  @ApiProperty({ type: [ConsentStateDto] })
  consents: ConsentStateDto[];

  @ApiProperty({ nullable: true, type: DeletionRequestDto })
  deletionRequest: DeletionRequestDto | null;

  @ApiProperty({ description: 'Refresh tokens that can still be used' })
  activeSessions: number;
}

export class BlockUserDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Stored in the audit log' })
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class RevokeSessionsResponseDto {
  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty()
  revokedSessions: number;
}

export class CreateAdminUserDto {
  @ApiProperty({ example: 'moderator@portcity.local' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  password: string;

  @ApiProperty({ enum: ADMIN_ROLES })
  @IsIn(ADMIN_ROLES)
  role: AdminRole;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class UpdateAdminUserDto {
  @ApiPropertyOptional({ enum: ADMIN_ROLES })
  @IsOptional()
  @IsIn(ADMIN_ROLES)
  role?: AdminRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string | null;

  @ApiPropertyOptional({ minLength: 12, maxLength: 200, description: 'Sets a new password' })
  @IsOptional()
  @IsString()
  @Length(12, 200)
  password?: string;
}

export class AdminUserListDto {
  @ApiProperty({ type: [AdminUserDto] })
  items: AdminUserDto[];
}
