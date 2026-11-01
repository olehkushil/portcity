import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/auth/auth.decorators';
import { MallInfoDto } from '../dto/mall-info.dto';
import { MallInfoService } from '../services/mall-info.service';

@ApiTags('content')
@Controller('mall')
@Public()
export class MallController {
  constructor(private readonly mallInfo: MallInfoService) {}

  @Get('info')
  @ApiOperation({
    summary:
      'Mall facts: hours, address, parking hours and operator, info desk, maps, documents, contacts',
    description:
      'Edited in the back office (PUT /admin/content/mall-info); anything not stored falls back to configuration. Hours are Kyiv wall-clock times; isOpenNow is computed at server time.',
  })
  @ApiOkResponse({ type: MallInfoDto })
  info(): Promise<MallInfoDto> {
    return this.mallInfo.getInfo();
  }
}
