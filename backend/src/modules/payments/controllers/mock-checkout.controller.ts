import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../common/auth/auth.decorators';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { CompleteMockCheckoutDto, MockCheckoutResultDto } from '../dto/mock-checkout.dto';
import { MockCheckoutService } from '../services/mock-checkout.service';

/**
 * Development only: the hosted checkout page behind the mock provider's `checkoutUrl`
 * (`PAYMENTS_MOCK_CHECKOUT_BASE_URL/<providerRef>`). Answers 404 in production and when
 * `PAYMENTS_PROVIDER` is not `mock`. Public like a real provider page; it can only settle mock
 * checkouts that exist in this API process.
 */
@ApiTags('payments')
@Controller('mock-checkout')
export class MockCheckoutController {
  constructor(private readonly checkout: MockCheckoutService) {}

  @Get(':providerRef')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Dev only: mock hosted checkout page',
    description: 'HTML page with "pay", "decline" and "cancel" buttons for a mock checkout.',
  })
  @ApiParam({ name: 'providerRef', example: 'mock_01900000-0000-7000-8000-000000000001' })
  @ApiProduces('text/html')
  @ApiOkResponse({ description: 'HTML page', schema: { type: 'string' } })
  @ApiProblemResponses(404)
  page(@Param('providerRef') providerRef: string): string {
    return this.checkout.renderPage(providerRef);
  }

  @Post(':providerRef/complete')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dev only: finish a mock checkout and deliver the signed provider webhook',
    description:
      'Settles the mock checkout with the outcome and posts a signed webhook through the regular webhook handler; repeating the same outcome is a duplicate webhook.',
  })
  @ApiParam({ name: 'providerRef', example: 'mock_01900000-0000-7000-8000-000000000001' })
  @ApiConsumes('application/json', 'application/x-www-form-urlencoded')
  @ApiOkResponse({ type: MockCheckoutResultDto })
  @ApiProblemResponses(400, 404, 409)
  complete(
    @Param('providerRef') providerRef: string,
    @Body() body: CompleteMockCheckoutDto,
  ): Promise<MockCheckoutResultDto> {
    return this.checkout.complete(providerRef, body.outcome, body.failureCode);
  }
}
