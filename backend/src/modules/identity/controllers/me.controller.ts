import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { DeletionRequestDto, DeviceDto } from '../dto/common.dto';
import {
  ChildDto,
  ChildrenResponseDto,
  ConsentsResponseDto,
  CreateChildDto,
  DeleteAccountDto,
  DeletionResponseDto,
  DevicesResponseDto,
  PersonalDataExportDto,
  ProfileDto,
  RemoveDeviceResponseDto,
  UpdateChildDto,
  UpdateConsentsDto,
  UpdateDeviceDto,
  UpdateProfileDto,
} from '../dto/me.dto';
import { AccountDeletionService } from '../services/account-deletion.service';
import { ChildrenService } from '../services/children.service';
import { DevicesService } from '../services/devices.service';
import { ProfileService } from '../services/profile.service';
import { uuidParam } from './params';

/** The member's own account (brief section 8, "auth": /me endpoints). */
@ApiTags('auth')
@Controller('me')
@Auth('member')
export class MeController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly children: ChildrenService,
    private readonly devices: DevicesService,
    private readonly deletions: AccountDeletionService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'My profile, children, profile completion, consents, pending deletion request and current device',
  })
  @ApiOkResponse({ type: ProfileDto })
  @ApiProblemResponses(404, 410)
  async getProfile(@CurrentUser() user: AuthenticatedUser): Promise<ProfileDto> {
    return this.profiles.getProfile(user.id, user.deviceId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Update name, birth date, e-mail, gender and city (null clears a field)',
    description:
      'Completing first name, last name and birth date for the first time publishes user.profile_completed (welcome bonus). The first time any of firstName, lastName, birthDate, email, gender, city is filled publishes user.profile_field_completed for it (once per field, also after clearing and refilling). 409 PC_USER_EMAIL_TAKEN (reveals that the e-mail is registered: accepted risk), 422 PC_USER_BIRTHDATE_INVALID (age 14-120).',
  })
  @ApiOkResponse({ type: ProfileDto })
  @ApiProblemResponses(400, 404, 409, 410, 422)
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateProfileDto,
  ): Promise<ProfileDto> {
    return this.profiles.updateProfile(user.id, user.deviceId, body);
  }

  @Get('children')
  @ApiOperation({ summary: 'My children (birth month and year, gender)' })
  @ApiOkResponse({ type: ChildrenResponseDto })
  @ApiProblemResponses(404, 410)
  async listChildren(@CurrentUser('id') userId: string): Promise<ChildrenResponseDto> {
    return this.children.list(userId);
  }

  @Post('children')
  @ApiOperation({
    summary: 'Add a child (at most 6)',
    description:
      'The first child publishes user.profile_field_completed { field: children }. 422 PC_USER_CHILD_LIMIT beyond 6, 422 PC_USER_CHILD_BIRTH_INVALID for a future month or a child older than 18.',
  })
  @ApiCreatedResponse({ type: ChildDto })
  @ApiProblemResponses(400, 404, 410, 422)
  async addChild(
    @CurrentUser('id') userId: string,
    @Body() body: CreateChildDto,
  ): Promise<ChildDto> {
    return this.children.create(userId, body);
  }

  @Patch('children/:id')
  @ApiOperation({ summary: 'Change a child (birth month, year, gender)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ChildDto })
  @ApiProblemResponses(400, 404, 410, 422)
  async updateChild(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) childId: string,
    @Body() body: UpdateChildDto,
  ): Promise<ChildDto> {
    return this.children.update(userId, childId, body);
  }

  @Delete('children/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a child' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404, 410)
  async removeChild(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) childId: string,
  ): Promise<void> {
    await this.children.remove(userId, childId);
  }

  @Post('consents')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Grant or revoke consents: program, marketing, profiling',
    description:
      'A grant without a version accepts the current text from GET /legal/documents. The program consent cannot be revoked here (422 PC_CONSENT_PROGRAM_REQUIRED): use account deletion.',
  })
  @ApiOkResponse({ type: ConsentsResponseDto })
  @ApiProblemResponses(400, 404, 410, 422)
  async updateConsents(
    @CurrentUser('id') userId: string,
    @Body() body: UpdateConsentsDto,
  ): Promise<ConsentsResponseDto> {
    return this.profiles.updateConsents(userId, body.consents);
  }

  @Get('devices')
  @ApiOperation({ summary: 'My devices (push tokens are never returned)' })
  @ApiOkResponse({ type: DevicesResponseDto })
  async listDevices(@CurrentUser() user: AuthenticatedUser): Promise<DevicesResponseDto> {
    return this.devices.listDevices(user.id, user.deviceId);
  }

  @Post('devices')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Register the push token (and app details) of the current device',
    description:
      'Applies to the device bound to the access token. A token registered here is removed from any other device row. null removes the token and disables push.',
  })
  @ApiOkResponse({ type: DeviceDto })
  @ApiProblemResponses(400, 404)
  async updateDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateDeviceDto,
  ): Promise<DeviceDto> {
    return this.devices.updateCurrentDevice(user.id, user.deviceId, body);
  }

  @Delete('devices/:id')
  @ApiOperation({ summary: 'Sign a device out (sessions revoked, push stopped)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: RemoveDeviceResponseDto })
  @ApiProblemResponses(400, 404)
  async removeDevice(
    @CurrentUser('id') userId: string,
    @Param('id', uuidParam()) deviceId: string,
  ): Promise<RemoveDeviceResponseDto> {
    return this.devices.removeDevice(userId, deviceId);
  }

  @Delete()
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Request account deletion (executed after ACCOUNT_DELETION_GRACE_DAYS, default 30, unless cancelled)',
    description:
      'Idempotent: a pending request is returned with created=false. The response carries executeAfter and graceDays. The daily account-deletion job anonymises the account after executeAfter; points history stays with an anonymised owner.',
  })
  @ApiAcceptedResponse({ type: DeletionResponseDto })
  @ApiProblemResponses(400, 403, 404, 410)
  async requestDeletion(
    @CurrentUser('id') userId: string,
    @Body() body: DeleteAccountDto,
  ): Promise<DeletionResponseDto> {
    return this.deletions.requestDeletion(userId, body?.reason ?? null);
  }

  @Delete('deletion')
  @ApiOperation({ summary: 'Cancel the pending account deletion request' })
  @ApiOkResponse({ type: DeletionRequestDto })
  @ApiProblemResponses(404)
  async cancelDeletion(@CurrentUser('id') userId: string): Promise<DeletionRequestDto> {
    return this.deletions.cancelDeletion(userId);
  }

  @Get('export')
  @ApiOperation({
    summary: 'Download my personal data held by the identity module (JSON)',
  })
  @ApiOkResponse({ type: PersonalDataExportDto })
  @ApiProblemResponses(404, 410)
  async exportData(@CurrentUser() user: AuthenticatedUser): Promise<PersonalDataExportDto> {
    return this.profiles.exportPersonalData(user.id, user.deviceId);
  }
}
