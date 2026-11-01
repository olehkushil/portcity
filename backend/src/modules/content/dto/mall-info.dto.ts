import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { HOURS_RANGE_PATTERN } from '../domain/mall-hours';
import { MAX_FLOOR_MAPS, MAX_LEGAL_DOCUMENTS } from '../domain/mall-info';
import { transformTrimToNull } from './transforms';
import { TENANT_FLOOR_MAX, TENANT_FLOOR_MIN } from './tenant.dto';

const URL_OPTIONS = { protocols: ['http', 'https'], require_protocol: true };

export class HoursRangeDto {
  @ApiProperty({ example: '10:00', description: 'HH:mm, Kyiv time' })
  from: string;

  @ApiProperty({ example: '22:00', description: 'HH:mm, Kyiv time; 24:00 means midnight' })
  to: string;
}

export class MallHoursDto extends HoursRangeDto {
  @ApiProperty({ description: 'Whether the mall is open at server time (Kyiv wall clock)' })
  isOpenNow: boolean;
}

export class MallParkingHoursDto {
  @ApiProperty({ type: HoursRangeDto })
  underground: HoursRangeDto;

  @ApiProperty({ type: HoursRangeDto })
  surface: HoursRangeDto;
}

export class MallSupportDto {
  @ApiProperty({ nullable: true, type: String, example: '+380 332 000 000' })
  phone: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'support@portcity.com.ua' })
  email: string | null;
}

export class MallInfoDeskDto {
  @ApiProperty({ nullable: true, type: String, example: '1 поверх, центральний вхід' })
  location: string | null;

  @ApiProperty({ nullable: true, type: String, example: '10:00-22:00' })
  hours: string | null;
}

export class MallParkingOperatorDto {
  @ApiProperty({ nullable: true, type: String, example: 'ТОВ «Паркінг Сервіс»' })
  name: string | null;

  @ApiProperty({ nullable: true, type: String, example: '+380 50 000 00 00' })
  phone: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'цілодобово' })
  hours: string | null;
}

export class LegalDocumentDto {
  @ApiProperty({
    example: 'privacy',
    description: 'Stable key: privacy, program_rules, offer, ...',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,49}$/)
  key: string;

  @ApiProperty({ example: 'Політика конфіденційності', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: 'https://portcity.com.ua/privacy.pdf' })
  @IsUrl(URL_OPTIONS)
  @MaxLength(500)
  url: string;
}

export class FloorMapDto {
  @ApiProperty({ example: 1, minimum: TENANT_FLOOR_MIN, maximum: TENANT_FLOOR_MAX })
  @IsInt()
  @Min(TENANT_FLOOR_MIN)
  @Max(TENANT_FLOOR_MAX)
  floor: number;

  @ApiProperty({ example: 'https://cdn.portcity.com.ua/mall/floor-1.png' })
  @IsUrl(URL_OPTIONS)
  @MaxLength(500)
  url: string;
}

/** GET /mall/info (public). */
export class MallInfoDto {
  @ApiProperty({ example: 'Порт City' })
  name: string;

  @ApiProperty({ example: 'просп. Соборності, 43, Луцьк' })
  address: string;

  @ApiProperty({ example: 'https://portcity.com.ua' })
  website: string;

  @ApiProperty({ example: 'Europe/Kyiv' })
  timezone: string;

  @ApiProperty({ type: MallHoursDto })
  hours: MallHoursDto;

  @ApiProperty({ type: MallParkingHoursDto })
  parking: MallParkingHoursDto;

  @ApiProperty({ type: MallSupportDto })
  support: MallSupportDto;

  @ApiProperty({ nullable: true, type: String, example: 'https://t.me/portcity_lutsk' })
  telegramUrl: string | null;

  @ApiProperty({ nullable: true, type: MallInfoDeskDto, description: 'Інформаційна стійка' })
  infoDesk: MallInfoDeskDto | null;

  @ApiProperty({ nullable: true, type: MallParkingOperatorDto })
  parkingOperator: MallParkingOperatorDto | null;

  @ApiProperty({ nullable: true, type: String, description: 'Правила ТРЦ (PDF)' })
  rulesPdfUrl: string | null;

  @ApiProperty({ type: [LegalDocumentDto], description: 'Юридичні документи програми' })
  legalDocuments: LegalDocumentDto[];

  @ApiProperty({ type: [FloorMapDto], description: 'Плани поверхів' })
  floorMapUrls: FloorMapDto[];

  @ApiProperty({ nullable: true, type: String, description: 'Схема паркінгу' })
  parkingMapUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'Server time (UTC)' })
  serverTime: Date;
}

// ---------------------------------------------------------------------------
// Back office: PUT /admin/content/mall-info
// ---------------------------------------------------------------------------

export class UpdateMallInfoDeskDto {
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 200 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(200)
  location?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '10:00-22:00' })
  @IsOptional()
  @Transform(transformTrimToNull)
  @Matches(HOURS_RANGE_PATTERN, { message: 'hours must be HH:mm-HH:mm' })
  hours?: string | null;
}

export class UpdateMallParkingOperatorDto {
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 200 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(200)
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 32 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 64, example: 'цілодобово' })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(64)
  hours?: string | null;
}

export class UpdateMallSupportDto {
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 32 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 200 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsEmail()
  @MaxLength(200)
  email?: string | null;
}

/**
 * Full replacement of the stored mall facts (PUT semantics): an omitted or null field falls back
 * to configuration (address MALL_ADDRESS, hours MALL_HOURS, support SUPPORT_PHONE / SUPPORT_EMAIL)
 * or disappears from GET /mall/info.
 */
export class UpdateMallInfoDto {
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 300 })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '10:00-22:00' })
  @IsOptional()
  @Transform(transformTrimToNull)
  @Matches(HOURS_RANGE_PATTERN, { message: 'hours must be HH:mm-HH:mm' })
  hours?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'https://t.me/portcity_lutsk' })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsUrl(URL_OPTIONS)
  @MaxLength(500)
  telegramUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: UpdateMallInfoDeskDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMallInfoDeskDto)
  infoDesk?: UpdateMallInfoDeskDto | null;

  @ApiPropertyOptional({ nullable: true, type: UpdateMallParkingOperatorDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMallParkingOperatorDto)
  parkingOperator?: UpdateMallParkingOperatorDto | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsUrl(URL_OPTIONS)
  @MaxLength(500)
  rulesPdfUrl?: string | null;

  @ApiPropertyOptional({ type: [LegalDocumentDto], maxItems: MAX_LEGAL_DOCUMENTS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LEGAL_DOCUMENTS)
  @ValidateNested({ each: true })
  @Type(() => LegalDocumentDto)
  legalDocuments?: LegalDocumentDto[];

  @ApiPropertyOptional({ type: [FloorMapDto], maxItems: MAX_FLOOR_MAPS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FLOOR_MAPS)
  @ValidateNested({ each: true })
  @Type(() => FloorMapDto)
  floorMapUrls?: FloorMapDto[];

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(transformTrimToNull)
  @IsUrl(URL_OPTIONS)
  @MaxLength(500)
  parkingMapUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: UpdateMallSupportDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateMallSupportDto)
  support?: UpdateMallSupportDto | null;
}

/** What is stored in mall_info (null = falls back to configuration), with the last editor. */
export class MallInfoAdminDto {
  @ApiProperty({ nullable: true, type: String })
  address: string | null;

  @ApiProperty({ nullable: true, type: String })
  hours: string | null;

  @ApiProperty({ nullable: true, type: String })
  telegramUrl: string | null;

  @ApiProperty({ type: MallInfoDeskDto })
  infoDesk: MallInfoDeskDto;

  @ApiProperty({ type: MallParkingOperatorDto })
  parkingOperator: MallParkingOperatorDto;

  @ApiProperty({ nullable: true, type: String })
  rulesPdfUrl: string | null;

  @ApiProperty({ type: [LegalDocumentDto] })
  legalDocuments: LegalDocumentDto[];

  @ApiProperty({ type: [FloorMapDto] })
  floorMapUrls: FloorMapDto[];

  @ApiProperty({ nullable: true, type: String })
  parkingMapUrl: string | null;

  @ApiProperty({ type: MallSupportDto })
  support: MallSupportDto;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  updatedById: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  updatedAt: Date | null;

  @ApiProperty({ type: MallInfoDto, description: 'What GET /mall/info answers right now' })
  effective: MallInfoDto;
}
