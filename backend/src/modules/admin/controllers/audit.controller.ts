import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Auth } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { normaliseAuditFilter } from '../domain/audit-filter';
import { ADMIN_ROLE_SETS } from '../domain/roles';
import { AuditLogDto, AuditPageDto, AuditQueryDto } from '../dto/audit.dto';
import { AuditLogService } from '../services/audit-log.service';

@ApiTags('admin')
@Controller('admin/audit')
export class AuditController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({
    summary: 'Search the audit trail',
    description:
      'Newest first. Filter by entity (entityType + entityId), actor (actorType, actorId), action (exact or `prefix.*`) and a createdAt window.',
  })
  @ApiOkResponse({ type: AuditPageDto })
  @ApiProblemResponses(400)
  async list(@Query() query: AuditQueryDto): Promise<AuditPageDto> {
    const filter = normaliseAuditFilter({
      entityType: query.entityType,
      entityId: query.entityId,
      actorType: query.actorType,
      actorId: query.actorId,
      action: query.action,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return this.auditLog.list(filter, { cursor: query.cursor, limit: query.limit });
  }

  @Get(':id')
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({ summary: 'Get one audit entry' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AuditLogDto })
  @ApiProblemResponses(400, 404)
  async get(@Param('id', new ParseUUIDPipe()) id: string): Promise<AuditLogDto> {
    return this.auditLog.get(id);
  }
}
