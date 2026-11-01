import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '../../../common/auth/auth.decorators';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { ADMIN_ROLE_SETS } from '../domain/roles';
import {
  DailyReportDto,
  DailyReportListDto,
  DailyReportQueryDto,
  DailyReportRangeQueryDto,
  RecomputeDailyReportDto,
} from '../dto/reports.dto';
import { ReportsService } from '../services/reports.service';

@ApiTags('admin')
@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({
    summary:
      'Daily report: receipts by status, points earned/spent, vouchers, parking, adjustments',
    description:
      'Returns the stored report for the Kyiv day (default yesterday) written by the reports-nightly job. 404 PC_REPORT_NOT_READY when it has not been computed yet.',
  })
  @ApiOkResponse({ type: DailyReportDto })
  @ApiProblemResponses(400, 404)
  async daily(@Query() query: DailyReportQueryDto): Promise<DailyReportDto> {
    return this.reports.getStored(query.day);
  }

  @Get('daily/range')
  @Auth('admin', ...ADMIN_ROLE_SETS.read)
  @ApiOperation({ summary: 'Stored daily reports for a range of days (inclusive, max 92 days)' })
  @ApiOkResponse({ type: DailyReportListDto })
  @ApiProblemResponses(400)
  async range(@Query() query: DailyReportRangeQueryDto): Promise<DailyReportListDto> {
    return { items: await this.reports.listStored(query.from, query.to) };
  }

  @Post('daily/recompute')
  @Auth('admin', ...ADMIN_ROLE_SETS.reportRecompute)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recompute and store the daily report for a day (default yesterday)',
    description:
      'Audited. Sources that fail are reported in `errors` and left null instead of failing the request.',
  })
  @ApiOkResponse({ type: DailyReportDto })
  @ApiProblemResponses(400)
  async recompute(
    @Body() body: RecomputeDailyReportDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ): Promise<DailyReportDto> {
    return this.reports.recompute(body.day, { id: user.id, ip });
  }
}
