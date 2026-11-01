import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ActiveRuleSet, LoyaltyRules } from '../../../common/contracts/club';
import { type LoyaltyRulesPatch, publicRulesView } from '../domain/rules';
import type { RuleSetView } from '../services/rule-sets.service';

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export class ClubWelcomeBonusesDto {
  @ApiProperty({ example: 50 })
  register: number;

  @ApiProperty({ example: 30 })
  profile: number;

  @ApiProperty({ example: 20 })
  firstReceipt: number;
}

/** Program rules a member may see (`GET /club/rules`); the anti-fraud threshold is hidden. */
export class PublicLoyaltyRulesDto {
  @ApiProperty({ description: 'Rule set version in force (0 = built-in defaults)', example: 1 })
  version: number;

  @ApiProperty({ type: String, format: 'date-time' })
  activeFrom: string;

  @ApiProperty({ description: 'Points per 100 UAH spent = baseRatePercent', example: 3 })
  baseRatePercent: number;

  @ApiProperty({ example: 500 })
  maxPointsPerReceipt: number;

  @ApiProperty({ example: 0 })
  minReceiptTotalKopecks: number;

  @ApiProperty({ example: 10 })
  dailyReceiptLimit: number;

  @ApiProperty({ description: 'Receipts above this total are held', example: 300000 })
  holdThresholdKopecks: number;

  @ApiProperty({ example: 7 })
  holdDays: number;

  @ApiProperty({ example: 7 })
  uploadWindowDays: number;

  @ApiProperty({ example: 12 })
  pointsTtlMonths: number;

  @ApiProperty({ example: 72 })
  newcomerLockHours: number;

  @ApiProperty({ type: ClubWelcomeBonusesDto })
  welcome: ClubWelcomeBonusesDto;

  @ApiProperty({ example: 100 })
  pointValueKopecks: number;

  @ApiProperty({ type: [Number], example: [30, 7] })
  expiryReminderDays: number[];
}

/** Full configuration of a rule set (back office). */
export class LoyaltyRulesDto {
  @ApiProperty({ example: 3 })
  baseRatePercent: number;

  @ApiProperty({ example: 500 })
  maxPointsPerReceipt: number;

  @ApiProperty({ example: 0 })
  minReceiptTotalKopecks: number;

  @ApiProperty({ example: 10 })
  dailyReceiptLimit: number;

  @ApiProperty({ example: 100000 })
  autoApproveThresholdKopecks: number;

  @ApiProperty({ example: 300000 })
  holdThresholdKopecks: number;

  @ApiProperty({ example: 7 })
  holdDays: number;

  @ApiProperty({ example: 7 })
  uploadWindowDays: number;

  @ApiProperty({ example: 12 })
  pointsTtlMonths: number;

  @ApiProperty({ example: 72 })
  newcomerLockHours: number;

  @ApiProperty({ type: ClubWelcomeBonusesDto })
  welcome: ClubWelcomeBonusesDto;

  @ApiProperty({ example: 100 })
  pointValueKopecks: number;

  @ApiProperty({ type: [Number], example: [30, 7] })
  expiryReminderDays: number[];
}

export class LoyaltyRuleSetDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 2 })
  version: number;

  @ApiProperty({ type: String, format: 'date-time' })
  activeFrom: string;

  @ApiProperty({ type: LoyaltyRulesDto })
  config: LoyaltyRulesDto;

  @ApiProperty({ type: String, nullable: true })
  note: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiProperty({ description: 'True for the version in force right now' })
  active: boolean;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export class ClubWelcomeBonusesPatchDto {
  @ApiPropertyOptional({ minimum: 0, example: 50 })
  @IsOptional()
  @IsInt()
  @Min(0)
  register?: number;

  @ApiPropertyOptional({ minimum: 0, example: 30 })
  @IsOptional()
  @IsInt()
  @Min(0)
  profile?: number;

  @ApiPropertyOptional({ minimum: 0, example: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  firstReceipt?: number;
}

/**
 * Partial configuration merged over the rules in force at `activeFrom`. Field-level checks
 * here; cross-field business validation (`validateLoyaltyRules`) runs in the service.
 */
export class LoyaltyRulesPatchDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 100, example: 3 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  baseRatePercent?: number;

  @ApiPropertyOptional({ minimum: 1, example: 500 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxPointsPerReceipt?: number;

  @ApiPropertyOptional({ minimum: 0, example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minReceiptTotalKopecks?: number;

  @ApiPropertyOptional({ minimum: 1, example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  dailyReceiptLimit?: number;

  @ApiPropertyOptional({ minimum: 0, example: 100000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  autoApproveThresholdKopecks?: number;

  @ApiPropertyOptional({ minimum: 0, example: 300000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  holdThresholdKopecks?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 365, example: 7 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  holdDays?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365, example: 7 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  uploadWindowDays?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 120, example: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  pointsTtlMonths?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 8760, example: 72 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8760)
  newcomerLockHours?: number;

  @ApiPropertyOptional({ type: ClubWelcomeBonusesPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ClubWelcomeBonusesPatchDto)
  welcome?: ClubWelcomeBonusesPatchDto;

  @ApiPropertyOptional({ minimum: 1, example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  pointValueKopecks?: number;

  @ApiPropertyOptional({ type: [Number], example: [30, 7], maxItems: 10 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(0, { each: true })
  expiryReminderDays?: number[];
}

export class CreateLoyaltyRuleSetDto {
  @ApiPropertyOptional({ minimum: 1, description: 'Defaults to the highest version + 1' })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Defaults to now; a future moment schedules the version. Never in the past.',
  })
  @IsOptional()
  @IsDateString()
  activeFrom?: string;

  @ApiPropertyOptional({ type: LoyaltyRulesPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyRulesPatchDto)
  config?: LoyaltyRulesPatchDto;

  @ApiPropertyOptional({ maxLength: 500, example: 'Подвійні бали на Чорну п’ятницю' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Only versions scheduled for the future can be edited. */
export class UpdateLoyaltyRuleSetDto {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  activeFrom?: string;

  @ApiPropertyOptional({ type: LoyaltyRulesPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LoyaltyRulesPatchDto)
  config?: LoyaltyRulesPatchDto;

  @ApiPropertyOptional({ type: String, maxLength: 500, nullable: true, description: 'null clears' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class DeleteLoyaltyRuleSetQueryDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------

function rulesDto(rules: LoyaltyRules): LoyaltyRulesDto {
  return {
    ...rules,
    welcome: { ...rules.welcome },
    expiryReminderDays: [...rules.expiryReminderDays],
  };
}

export function toPublicRulesDto(active: ActiveRuleSet): PublicLoyaltyRulesDto {
  const view = publicRulesView(active.rules);
  return {
    version: active.version,
    activeFrom: active.activeFrom.toISOString(),
    ...view,
    welcome: { ...view.welcome },
    expiryReminderDays: [...view.expiryReminderDays],
  };
}

export function toRuleSetDto(view: RuleSetView): LoyaltyRuleSetDto {
  return {
    id: view.id,
    version: view.version,
    activeFrom: view.activeFrom.toISOString(),
    config: rulesDto(view.config),
    note: view.note,
    createdById: view.createdById,
    createdAt: view.createdAt.toISOString(),
    active: view.active,
  };
}

/** Strips undefined keys so a patch never resets a field to the base value by accident. */
export function toRulesPatch(dto: LoyaltyRulesPatchDto | undefined): LoyaltyRulesPatch | undefined {
  if (!dto) {
    return undefined;
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dto)) {
    if (value === undefined) {
      continue;
    }
    if (key === 'welcome' && typeof value === 'object' && value !== null) {
      patch.welcome = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, inner]) => inner !== undefined),
      );
      continue;
    }
    patch[key] = value;
  }
  return patch;
}
