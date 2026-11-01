import { Body, Controller, Get, Ip, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { MallInfoAdminDto, UpdateMallInfoDto } from '../dto/mall-info.dto';
import { MallInfoService } from '../services/mall-info.service';
import { CONTENT_READ_ROLES, CONTENT_WRITE_ROLES } from './admin-roles';

/** Back-office editing of the mall facts behind GET /mall/info (audited `mall_info.update`). */
@ApiTags('admin')
@Controller('admin/content/mall-info')
@Auth('admin', ...CONTENT_READ_ROLES)
export class AdminMallInfoController {
  constructor(private readonly mallInfo: MallInfoService) {}

  @Get()
  @ApiOperation({ summary: 'Stored mall facts (null = configuration) and the effective answer' })
  @ApiOkResponse({ type: MallInfoAdminDto })
  get(): Promise<MallInfoAdminDto> {
    return this.mallInfo.getAdminView();
  }

  @Put()
  @Roles(...CONTENT_WRITE_ROLES)
  @ApiOperation({
    summary: 'Replace the mall facts (PUT semantics: omitted fields fall back to configuration)',
    description:
      'address, hours (HH:mm-HH:mm), telegramUrl, infoDesk {location, hours}, parkingOperator {name, phone, hours}, rulesPdfUrl, legalDocuments [{key, title, url}], floorMapUrls [{floor, url}], parkingMapUrl, support {phone, email}.',
  })
  @ApiOkResponse({ type: MallInfoAdminDto })
  @ApiProblemResponses(400)
  update(
    @Body() body: UpdateMallInfoDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<MallInfoAdminDto> {
    return this.mallInfo.update(body, { id: adminId, ip });
  }
}
