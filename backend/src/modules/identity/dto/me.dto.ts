import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CONSENT_PURPOSES,
  type ConsentPurpose,
  GENDERS,
  type Gender,
  PROFILE_FIELDS,
  type ProfileField,
} from '../../../common/contracts/identity';
import { MAX_CHILDREN } from '../domain/children';
import { CONSENT_VERSION_PATTERN } from '../domain/consents';
import { ConsentStateDto, DeletionRequestDto, DeviceDto, SessionDto, UserDto } from './common.dto';

export class ChildDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ minimum: 1, maximum: 12, example: 5 })
  birthMonth: number;

  @ApiProperty({ example: 2019 })
  birthYear: number;

  @ApiProperty({ enum: GENDERS })
  gender: Gender;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class ChildrenResponseDto {
  @ApiProperty({ type: [ChildDto], description: 'Oldest first' })
  items: ChildDto[];

  @ApiProperty({ example: MAX_CHILDREN, description: 'How many children a profile may list' })
  max: number;
}

export class CreateChildDto {
  @ApiProperty({ minimum: 1, maximum: 12, example: 5 })
  @IsInt()
  @Min(1)
  @Max(12)
  birthMonth: number;

  @ApiProperty({
    minimum: 1900,
    example: 2019,
    description: 'At most 18 years ago, not in the future',
  })
  @IsInt()
  @Min(1900)
  @Max(2200)
  birthYear: number;

  @ApiPropertyOptional({ enum: GENDERS, default: 'unspecified' })
  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender;
}

export class UpdateChildDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  birthMonth?: number;

  @ApiPropertyOptional({ minimum: 1900 })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2200)
  birthYear?: number;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender;
}

export class ProfileCompletionDto {
  @ApiProperty({ example: 57, description: 'Share of the 7 profile fields filled, 0-100' })
  percent: number;

  @ApiProperty({
    enum: PROFILE_FIELDS,
    isArray: true,
    example: ['email', 'children', 'city'],
    description: 'Fields still empty (children = no child listed)',
  })
  missing: ProfileField[];

  @ApiProperty({
    example: 10,
    description: 'Points for each field filled for the first time (PROFILE_BONUS_PER_FIELD)',
  })
  bonusPerField: number;

  @ApiProperty({
    example: 20,
    description: 'Extra points once every field has been filled (PROFILE_BONUS_COMPLETE)',
  })
  bonusComplete: number;
}

export class ProfileDto {
  @ApiProperty({ type: UserDto })
  user: UserDto;

  @ApiProperty({ type: [ChildDto] })
  children: ChildDto[];

  @ApiProperty({ type: ProfileCompletionDto })
  profileCompletion: ProfileCompletionDto;

  @ApiProperty({ type: [ConsentStateDto], description: 'Current state per purpose' })
  consents: ConsentStateDto[];

  @ApiProperty({ nullable: true, type: DeletionRequestDto })
  deletionRequest: DeletionRequestDto | null;

  @ApiProperty({ nullable: true, type: DeviceDto, description: 'Device of the access token' })
  currentDevice: DeviceDto | null;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Олег', nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string | null;

  @ApiPropertyOptional({ example: 'Демо', nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({
    example: '1990-05-14',
    nullable: true,
    description: 'yyyy-MM-dd; members must be 14 to 120 years old',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthDate must be yyyy-MM-dd' })
  birthDate?: string | null;

  @ApiPropertyOptional({ example: 'oleh@example.com', nullable: true, maxLength: 254 })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({
    enum: GENDERS,
    nullable: true,
    description: 'unspecified = "prefer not to say" (counts as answered); null clears',
  })
  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender | null;

  @ApiPropertyOptional({ example: 'Луцьк', nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;
}

export class ConsentChangeDto {
  @ApiProperty({ enum: CONSENT_PURPOSES })
  @IsIn(CONSENT_PURPOSES)
  purpose: ConsentPurpose;

  @ApiProperty({ description: 'true grants, false revokes' })
  @IsBoolean()
  granted: boolean;

  @ApiPropertyOptional({
    example: '2026-10',
    description:
      'Version of the accepted text; omitted on a grant = the current version from GET /legal/documents',
  })
  @IsOptional()
  @IsString()
  @Matches(CONSENT_VERSION_PATTERN, {
    message: 'version must be 1-32 letters, digits, ".", "_" or "-"',
  })
  version?: string;
}

export class UpdateConsentsDto {
  @ApiProperty({ type: [ConsentChangeDto], minItems: 1, maxItems: 3 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ConsentChangeDto)
  consents: ConsentChangeDto[];
}

export class ConsentsResponseDto {
  @ApiProperty({ type: [ConsentStateDto] })
  consents: ConsentStateDto[];
}

export class UpdateDeviceDto {
  @ApiPropertyOptional({
    description: 'FCM/APNs token; null removes it and disables push',
    nullable: true,
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pushToken?: string | null;

  @ApiPropertyOptional({ description: 'Defaults to true when a push token is sent' })
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

export class DevicesResponseDto {
  @ApiProperty({ type: [DeviceDto] })
  devices: DeviceDto[];
}

export class RemoveDeviceResponseDto {
  @ApiProperty({ format: 'uuid' })
  deviceId: string;

  @ApiProperty({ description: 'Refresh tokens of that device revoked by this call' })
  revokedSessions: number;
}

export class DeleteAccountDto {
  @ApiPropertyOptional({ maxLength: 500, description: 'Why the member leaves (optional)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DeletionResponseDto {
  @ApiProperty({ type: DeletionRequestDto })
  request: DeletionRequestDto;

  @ApiProperty({ description: 'False when a pending request already existed' })
  created: boolean;

  @ApiProperty({
    format: 'date-time',
    description: 'When the account will be anonymised unless cancelled (request.executeAfter)',
  })
  executeAfter: string;

  @ApiProperty({ example: 30, description: 'Cooling-off period (ACCOUNT_DELETION_GRACE_DAYS)' })
  graceDays: number;
}

export class PersonalDataExportDto {
  @ApiProperty({ format: 'date-time' })
  exportedAt: string;

  @ApiProperty({ type: UserDto })
  user: UserDto;

  @ApiProperty({ type: [ChildDto] })
  children: ChildDto[];

  @ApiProperty({ type: [DeviceDto] })
  devices: DeviceDto[];

  @ApiProperty({ type: [ConsentStateDto], description: 'Full consent history, oldest first' })
  consentHistory: ConsentStateDto[];

  @ApiProperty({ type: [DeletionRequestDto] })
  deletionRequests: DeletionRequestDto[];

  @ApiProperty({ type: [SessionDto], description: 'Last 100 login sessions (no secrets)' })
  sessions: SessionDto[];

  @ApiProperty({
    description:
      'Where the rest of the personal data lives (receipts, points, vouchers, parking, payments)',
  })
  note: string;
}
