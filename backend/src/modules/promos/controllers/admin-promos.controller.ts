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
import { AdminReasonDto, CreatePromoDto, UpdatePromoDto } from '../dto/admin-promo.dto';
import { AdminListPromosQueryDto } from '../dto/promo-query.dto';
import { PromoDto, PromoPageDto } from '../dto/promo.dto';
import { PromosAdminService } from '../services/promos-admin.service';

/** Back-office promos. Reads: manager, support, moderator (owner always); writes: manager. */
@ApiTags('admin')
@Controller('admin/promos')
@Auth('admin', 'manager', 'support', 'moderator')
export class AdminPromosController {
  constructor(private readonly admin: PromosAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List promos (any status)' })
  @ApiOkResponse({ type: PromoPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: AdminListPromosQueryDto): Promise<PromoPageDto> {
    return this.admin.listPromos(query);
  }

  @Post()
  @Roles('manager')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a draft promo (optionally with an inline coupon template)' })
  @ApiCreatedResponse({ type: PromoDto })
  @ApiProblemResponses(400, 404, 409, 422)
  create(
    @Body() body: CreatePromoDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<PromoDto> {
    return this.admin.createPromo(body, { id: adminId, ip });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Promo detail' })
  @ApiOkResponse({ type: PromoDto })
  @ApiProblemResponses(400, 404)
  get(@Param('id', ParseUUIDPipe) promoId: string): Promise<PromoDto> {
    return this.admin.getPromo(promoId);
  }

  @Patch(':id')
  @Roles('manager')
  @ApiOperation({ summary: 'Update promo fields' })
  @ApiOkResponse({ type: PromoDto })
  @ApiProblemResponses(400, 404, 409, 422)
  update(
    @Param('id', ParseUUIDPipe) promoId: string,
    @Body() body: UpdatePromoDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
  ): Promise<PromoDto> {
    return this.admin.updatePromo(promoId, body, { id: adminId, ip });
  }

  @Delete(':id')
  @Roles('manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a draft promo' })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 404, 409)
  async remove(
    @Param('id', ParseUUIDPipe) promoId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminReasonDto,
  ): Promise<void> {
    await this.admin.deletePromo(promoId, { id: adminId, ip }, body.reason);
  }

  @Post(':id/publish')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a draft promo (emits promo.published)' })
  @ApiOkResponse({ type: PromoDto })
  @ApiProblemResponses(400, 404, 409, 422)
  publish(
    @Param('id', ParseUUIDPipe) promoId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminReasonDto,
  ): Promise<PromoDto> {
    return this.admin.publishPromo(promoId, { id: adminId, ip }, body.reason);
  }

  @Post(':id/archive')
  @Roles('manager')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a promo (final)' })
  @ApiOkResponse({ type: PromoDto })
  @ApiProblemResponses(400, 404, 409)
  archive(
    @Param('id', ParseUUIDPipe) promoId: string,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Body() body: AdminReasonDto,
  ): Promise<PromoDto> {
    return this.admin.archivePromo(promoId, { id: adminId, ip }, body.reason);
  }
}
