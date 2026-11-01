import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { SlugParamDto, UuidParamDto } from '../dto/params.dto';
import {
  ListTenantsQueryDto,
  TenantCategoryCountDto,
  TenantDetailsDto,
  TenantPageDto,
} from '../dto/tenant.dto';
import { TenantDirectoryService } from '../services/tenant-directory.service';

/** Public tenant directory of the mall (tab "ТРЦ"). Only active tenants are visible. */
@ApiTags('content')
@Controller('tenants')
@Public()
export class TenantsController {
  constructor(private readonly directory: TenantDirectoryService) {}

  @Get()
  @ApiOperation({
    summary: 'List active tenants (cursor pagination, sorted by name)',
    description:
      'Filters: participates (true/false), category, floor, q (name or slug). Each item carries earnsPoints ("нараховує бали") and the effective rate.',
  })
  @ApiOkResponse({ type: TenantPageDto })
  @ApiProblemResponses(400)
  list(@Query() query: ListTenantsQueryDto): Promise<TenantPageDto> {
    return this.directory.list(query);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Categories of active tenants with counts (filter chips)' })
  @ApiOkResponse({ type: [TenantCategoryCountDto] })
  categories(): Promise<TenantCategoryCountDto[]> {
    return this.directory.categories();
  }

  @Get('by-id/:id')
  @ApiOperation({
    summary: 'Tenant card by id (links from vouchers, promos and receipts)',
    description:
      'Same card as GET /tenants/:slug: earning flag, rate, hours, isOpenNow, location and map. Hidden and closed tenants answer 404.',
  })
  @ApiOkResponse({ type: TenantDetailsDto })
  @ApiProblemResponses(400, 404)
  getById(@Param() params: UuidParamDto): Promise<TenantDetailsDto> {
    return this.directory.getById(params.id);
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Tenant card by slug',
    description:
      'Includes earnsPoints ("нараховує бали"), effectiveRatePercent with its source, minimum receipt total and daily cap, weekly hours with isOpenNow (Kyiv time; the mall hours when the tenant has none), locationText and mapImageUrl. Hidden and closed tenants answer 404.',
  })
  @ApiOkResponse({ type: TenantDetailsDto })
  @ApiProblemResponses(400, 404)
  get(@Param() params: SlugParamDto): Promise<TenantDetailsDto> {
    return this.directory.getBySlug(params.slug);
  }
}
