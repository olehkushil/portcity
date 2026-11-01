import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/auth/auth.decorators';
import { currentLegalDocuments } from '../domain/legal';
import { LegalDocumentsResponseDto } from '../dto/legal.dto';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';

/**
 * Current consent texts (versions and URLs from the LEGAL_* variables), so the app shows the right
 * documents on the login screen and does not hard-code versions for `POST /auth/otp/verify` and
 * `POST /me/consents` (a grant without a version accepts the version listed here).
 */
@ApiTags('auth')
@Controller('legal')
@Public()
export class LegalController {
  constructor(@Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig) {}

  @Get('documents')
  @ApiOperation({ summary: 'Current consent documents: purpose, version, URL, required (public)' })
  @ApiOkResponse({ type: LegalDocumentsResponseDto })
  documents(): LegalDocumentsResponseDto {
    return {
      documents: currentLegalDocuments(this.config),
      privacyPolicyUrl: this.config.LEGAL_PRIVACY_POLICY_URL,
    };
  }
}
