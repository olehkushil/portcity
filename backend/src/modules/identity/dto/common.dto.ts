import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ADMIN_ROLES, type AdminRole } from '../../../common/auth/auth.types';
import {
  CONSENT_PURPOSES,
  type ConsentPurpose,
  GENDERS,
  type Gender,
  PLATFORMS,
  type Platform,
  USER_STATUSES,
  type UserStatus,
} from '../../../common/contracts/identity';

export class UserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: '+380501234567', description: 'E.164' })
  phone: string;

  @ApiProperty({ nullable: true, type: String, example: 'oleh@example.com' })
  email: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Олег' })
  firstName: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Демо' })
  lastName: string | null;

  @ApiProperty({ nullable: true, type: String, example: '1990-05-14', description: 'yyyy-MM-dd' })
  birthDate: string | null;

  @ApiProperty({
    nullable: true,
    enum: GENDERS,
    description: 'null = not answered; unspecified = "prefer not to say"',
  })
  gender: Gender | null;

  @ApiProperty({ nullable: true, type: String, example: 'Луцьк' })
  city: string | null;

  @ApiProperty({ enum: USER_STATUSES })
  status: UserStatus;

  @ApiProperty({ example: '734211800', description: '9 digits, printed on the club card' })
  memberCode: string;

  @ApiProperty({ example: '734 211 800' })
  memberCodeFormatted: string;

  @ApiProperty({ description: 'First name, last name and birth date are filled in' })
  profileCompleted: boolean;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  profileCompletedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  deletedAt: string | null;
}

export class DeviceDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: PLATFORMS })
  platform: Platform;

  @ApiProperty({ nullable: true, type: String, example: 'iPhone 15' })
  model: string | null;

  @ApiProperty({ nullable: true, type: String, example: '1.0.0' })
  appVersion: string | null;

  @ApiProperty()
  pushEnabled: boolean;

  @ApiProperty({ description: 'A push token is stored (the token itself is never returned)' })
  hasPushToken: boolean;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastSeenAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ description: 'True for the device of the access token used for the request' })
  current: boolean;
}

export class ConsentStateDto {
  @ApiProperty({ enum: CONSENT_PURPOSES })
  purpose: ConsentPurpose;

  @ApiProperty()
  granted: boolean;

  @ApiProperty({ nullable: true, type: String, example: '2026-10' })
  version: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  grantedAt: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  revokedAt: string | null;
}

export class DeletionRequestDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['pending', 'executed', 'cancelled'] })
  status: 'pending' | 'executed' | 'cancelled';

  @ApiProperty({ format: 'date-time' })
  requestedAt: string;

  @ApiProperty({
    format: 'date-time',
    description: 'The daily job anonymises the account after this moment',
  })
  executeAfter: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  executedAt: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  cancelledAt: string | null;

  @ApiProperty({ nullable: true, type: String })
  reason: string | null;
}

export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  deviceId: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  revokedAt: string | null;

  @ApiProperty()
  active: boolean;
}

export class SessionTokensDto {
  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({ description: 'HS256 JWT, 15 minutes' })
  accessToken: string;

  @ApiProperty({ format: 'date-time' })
  accessTokenExpiresAt: string;

  @ApiProperty({ description: 'Opaque, single use: every refresh returns a new one' })
  refreshToken: string;

  @ApiProperty({ format: 'date-time' })
  refreshTokenExpiresAt: string;
}

export class AdminUserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'admin@portcity.local' })
  email: string;

  @ApiProperty({ nullable: true, type: String })
  name: string | null;

  @ApiProperty({ enum: ADMIN_ROLES })
  role: AdminRole;

  @ApiProperty()
  active: boolean;

  @ApiProperty()
  totpEnabled: boolean;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastLoginAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class CountResponseDto {
  @ApiPropertyOptional({ description: 'Number of affected rows' })
  count: number;
}
