import { ApiProperty } from '@nestjs/swagger';
import { CONSENT_PURPOSES, type ConsentPurpose } from '../../../common/contracts/identity';

export class LegalDocumentDto {
  @ApiProperty({ enum: CONSENT_PURPOSES })
  purpose: ConsentPurpose;

  @ApiProperty({ example: 'Правила програми лояльності та згода на участь' })
  title: string;

  @ApiProperty({
    example: '2026-10',
    description: 'Send back as consents[].version (or omit it to accept this version)',
  })
  version: string;

  @ApiProperty({ example: 'https://portcity.com.ua/loyalty/rules' })
  url: string;

  @ApiProperty({ description: 'program is required to join; the others are optional' })
  required: boolean;
}

export class LegalDocumentsResponseDto {
  @ApiProperty({ type: [LegalDocumentDto], description: 'One document per consent purpose' })
  documents: LegalDocumentDto[];

  @ApiProperty({ example: 'https://portcity.com.ua/privacy' })
  privacyPolicyUrl: string;
}
