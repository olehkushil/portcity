import { Body, Controller, Get, HttpStatus, Ip, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Auth, CurrentUser, Roles } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import {
  ContentImportRunDto,
  ContentImportRunPageDto,
  ListImportRunsQueryDto,
  RunContentImportDto,
} from '../dto/content-import.dto';
import { UuidParamDto } from '../dto/params.dto';
import { ContentImportService } from '../services/content-import.service';
import { toImportRunDto } from '../services/mappers';
import { CONTENT_READ_ROLES, CONTENT_WRITE_ROLES } from './admin-roles';

/**
 * WordPress import stub: the caller posts WordPress REST posts (wp/v2) or normalised items;
 * tenants are upserted by slug (new ones start as non-participants). The run is executed
 * synchronously (201) or, with `async: true`, queued on `content-import` (202, status running)
 * and finished by the worker; every run is recorded in content_import_runs.
 */
@ApiTags('admin')
@Controller('admin/content')
@Auth('admin', ...CONTENT_READ_ROLES)
export class AdminContentImportController {
  constructor(private readonly imports: ContentImportService) {}

  @Post('import')
  @Roles(...CONTENT_WRITE_ROLES)
  @ApiOperation({
    summary:
      'Run the WordPress import stub (dryRun computes the plan without writing; async queues it)',
  })
  @ApiCreatedResponse({ type: ContentImportRunDto, description: 'Synchronous run finished' })
  @ApiAcceptedResponse({ type: ContentImportRunDto, description: 'Queued run (async: true)' })
  @ApiProblemResponses(400, 409, 422)
  async run(
    @Body() body: RunContentImportDto,
    @CurrentUser('id') adminId: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ContentImportRunDto> {
    const run = await this.imports.run(body, { id: adminId, ip });
    if (body.async === true) {
      response.status(HttpStatus.ACCEPTED);
    }
    return toImportRunDto(run);
  }

  @Get('import-runs')
  @ApiOperation({ summary: 'Import runs, newest first' })
  @ApiOkResponse({ type: ContentImportRunPageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: ListImportRunsQueryDto): Promise<ContentImportRunPageDto> {
    const page = await this.imports.list(query);
    return { items: page.items.map(toImportRunDto), nextCursor: page.nextCursor };
  }

  @Get('import-runs/:id')
  @ApiOperation({ summary: 'Import run detail with stats' })
  @ApiOkResponse({ type: ContentImportRunDto })
  @ApiProblemResponses(400, 404)
  async get(@Param() params: UuidParamDto): Promise<ContentImportRunDto> {
    return toImportRunDto(await this.imports.getById(params.id));
  }
}
