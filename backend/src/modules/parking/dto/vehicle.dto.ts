import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { VEHICLE_VERIFIED_VIA, type VehicleVerifiedVia } from '../../../common/contracts/parking';
import type { VehicleView } from '../services/vehicles.service';

export class AddVehicleDto {
  @ApiProperty({
    description:
      'Plate as typed: Latin or look-alike Cyrillic letters, spaces and dashes allowed; stored as Latin without spaces',
    example: 'АС 1234 ВС',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  plate: string;

  @ApiPropertyOptional({ description: 'Own name for the car', example: 'Моя Škoda', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @ApiPropertyOptional({
    description: 'Make it the default («Основне») vehicle; the first vehicle always is',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  makeDefault?: boolean;
}

export class VerifyVehicleDto {
  @ApiPropertyOptional({
    description: 'Number printed on the entry talon (exactly one of talonCode / paymatCode)',
    example: '0412-771234',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  talonCode?: string;

  @ApiPropertyOptional({
    description: 'Code from the paymat receipt (exactly one of talonCode / paymatCode)',
    example: '771234',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  paymatCode?: string;
}

export class VehicleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Normalised plate (Latin, no spaces)', example: 'AC1234BC' })
  plate: string;

  @ApiProperty({ example: 'AC 1234 BC' })
  plateDisplay: string;

  @ApiProperty({ type: String, nullable: true, example: 'Моя Škoda' })
  label: string | null;

  @ApiProperty({ description: 'Verified vehicles see full sessions and can pay in the app' })
  verified: boolean;

  @ApiProperty({ enum: VEHICLE_VERIFIED_VIA, example: 'talon' })
  verifiedVia: VehicleVerifiedVia;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt: string | null;

  @ApiProperty({ description: '«Основне» vehicle shown on the hero' })
  isDefault: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class VehicleListDto {
  @ApiProperty({ type: [VehicleDto] })
  items: VehicleDto[];
}

export function toVehicleDto(view: VehicleView): VehicleDto {
  return {
    id: view.id,
    plate: view.plate,
    plateDisplay: view.plateDisplay,
    label: view.label,
    verified: view.verified,
    verifiedVia: view.verifiedVia,
    verifiedAt: view.verifiedAt ? view.verifiedAt.toISOString() : null,
    isDefault: view.isDefault,
    createdAt: view.createdAt.toISOString(),
  };
}
