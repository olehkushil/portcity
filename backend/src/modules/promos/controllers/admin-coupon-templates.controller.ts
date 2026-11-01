import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  AdminReasonDto,
  CreateCouponTemplateDto,
  UpdateCouponTemplateDto,
} from '../dto/admin-promo.dto';
import { AdminListCouponTemplatesQueryDto } from '../dto/promo-query.dto';
import { CouponTemplateDto, CouponTemplatePageDto } from '../dto/promo.dto';
import { PromosAdminService } from '../services/promos-admin.service';

/** Back-office coupon templates (one template per coupon promo). */
@ApiTags('admin')
@Controller('admin/coupon-templates')
@Auth('admin', 'manager', 'support', 'moderator')
export class AdminCouponTemplatesController {
  constructor(private readonly admin: PromosAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List coupon templates' })
  @ApiOkResponse({ type: CouponTemplatePageDto })
  @ApiProblemResponses(400)
  list(@Query() query: AdminListCouponTemplatesQueryDto): Promise<CouponTemplatePageDto> {
    return this.admin.listTemplates(query);
  }

  @Post()
  @Roles('manager')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a coupon template' })
  @ApiCreatedResponse({ type: CouponTemplateDto })
  @ApiProblemResponses(400, 422)
  create(
    @Body() body: CreateCouponTemplateDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<CouponTemplateDto> {
    return this.admin.createTemplate(body, { id: adminId, ip });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Coupon template detail' })
  @ApiOkResponse({ type: CouponTemplateDto })
  @ApiProblemResponses(400, 404)
  get(@Param('id', ParseUUIDPipe) templateId: string): Promise<CouponTemplateDto> {
    return this.admin.getTemplate(templateId);
  }

  @Patch(':id')
  @Roles('manager')
  @ApiOperation({ summary: 'Update a coupon template' })
  @ApiOkResponse({ type: CouponTemplateDto })
  @ApiProblemResponses(400, 404, 422)
  update(
    @Param('id', ParseUUIDPipe) templateId: string,
    @Body() body: UpdateCouponTemplateDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<CouponTemplateDto> {
    return this.admin.updateTemplate(templateId, body, { id: adminId, ip });
  }

  @Delete(':id')
  @Roles('manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a coupon template that is not linked to a promo' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404, 409)
  async remove(
    @Param('id', ParseUUIDPipe) templateId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminReasonDto,
  ): Promise<void> {
    await this.admin.deleteTemplate(templateId, { id: adminId, ip }, body.reason);
  }
}
