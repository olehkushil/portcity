import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { PARKING_ZONES, type ParkingZone } from '../../../common/contracts/parking';

export class StartInfoSessionDto {
  @ApiProperty({
    enum: PARKING_ZONES,
    description: 'Asked first because of the 21:00 underground closing warning',
  })
  @IsIn(PARKING_ZONES)
  zone: ParkingZone;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Entry time: «Зараз», «−5», «−10», «−15 хв» or another time (not in the future)',
  })
  @IsISO8601({ strict: true })
  enteredAt: string;
}

export class UpdateInfoSessionDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Corrected entry time (not in the future, not older than the timer TTL)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  enteredAt?: string;

  @ApiPropertyOptional({ enum: PARKING_ZONES })
  @IsOptional()
  @IsIn(PARKING_ZONES)
  zone?: ParkingZone;
}

export class PaidAtPaymatDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: '«Виїзд до» from the paymat receipt; defaults to the end of the running hour',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  paidUntil?: string;
}
