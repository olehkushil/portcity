import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/auth/auth.decorators';
import { DomainError } from '../../../common/errors/domain-error';
import { ApiProblemResponses } from '../../../common/errors/api-problem.decorator';
import { CommonErrors } from '../../../common/errors/error-codes';
import { Clock } from '../../../common/time/clock';
import { payCharge } from '../domain/pay-charge';
import { deriveSessionState } from '../domain/session-state';
import { nextChargeFor } from '../domain/session-view';
import { HOUR_MS, MINUTE_MS } from '../domain/tariff';
import { describeTariff } from '../domain/tariff-describe';
import { toChargeLines } from '../dto/session.dto';
import {
  ParkingTariffDto,
  QuoteDto,
  QuoteRequestDto,
  toTariffConfigDto,
  toTariffDescriptionDto,
} from '../dto/tariff.dto';
import { PARKING_CONFIG, type ParkingConfig } from '../parking.config';
import { TariffService } from '../services/tariff.service';
import { toDate } from './uuid-param';

/** Longest stay the public calculator prices (keeps the breakdown small). */
const MAX_QUOTE_SPAN_MS = 7 * 24 * HOUR_MS;

function invalid(field: string, message: string): DomainError {
  return new DomainError(CommonErrors.PC_COMMON_VALIDATION, message, {
    details: [{ path: field, messages: [message] }],
  });
}

/** Public tariff and calculator (design brief S06 «Тарифи», «Калькулятор»). */
@ApiTags('parking')
@Controller('parking')
export class ParkingTariffController {
  constructor(
    private readonly tariffs: TariffService,
    private readonly clock: Clock,
    @Inject(PARKING_CONFIG) private readonly config: ParkingConfig,
  ) {}

  @Get('tariff')
  @Public()
  @ApiOperation({
    summary: 'Active parking tariff with ready-made Ukrainian lines',
    description:
      'First 30 min free, minutes 31-60 cost 20 UAH, each further started hour 40 UAH, hours ' +
      'starting 00:00-05:00 cost 500 UAH, exit by the end of the paid hour, lost talon 500 UAH.',
  })
  @ApiOkResponse({ type: ParkingTariffDto })
  async tariff(): Promise<ParkingTariffDto> {
    const active = await this.tariffs.getActiveTariff(this.clock.now());
    return {
      version: active.version,
      config: toTariffConfigDto(active.config),
      description: toTariffDescriptionDto(
        describeTariff(active.config, this.config.PARKING_AIR_RAID_FREE_EXIT_MINUTES),
      ),
    };
  }

  @Post('quote')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Price of a stay («Орієнтовно 60 ₴ · виїзд до 16:00»)',
    description: 'now defaults to the server time; paidUntil prices an overstay after a payment.',
  })
  @ApiOkResponse({ type: QuoteDto })
  @ApiProblemResponses(400)
  async quote(@Body() body: QuoteRequestDto): Promise<QuoteDto> {
    const enteredAt = toDate(body.enteredAt);
    const now = body.now ? toDate(body.now) : this.clock.now();
    const paidUntil = body.paidUntil ? toDate(body.paidUntil) : null;
    if (now.getTime() < enteredAt.getTime()) {
      throw invalid('enteredAt', 'enteredAt must not be after now');
    }
    if (now.getTime() - enteredAt.getTime() > MAX_QUOTE_SPAN_MS) {
      throw invalid('enteredAt', 'The calculator prices stays of up to 7 days');
    }
    if (paidUntil && paidUntil.getTime() < enteredAt.getTime()) {
      throw invalid('paidUntil', 'paidUntil must not be before enteredAt');
    }
    const active = await this.tariffs.getActiveTariff(now);
    const derived = deriveSessionState(
      { enteredAt, exitedAt: null, paidUntil, closedReason: null },
      now,
      active.config,
    );
    const result = derived.quote;
    const nextCharge = nextChargeFor(
      derived.status,
      result.freeUntil,
      result.currentHourEndsAt,
      enteredAt,
      active.config,
    );
    const fallbackStart = result.currentHourEndsAt;
    const charge = payCharge(result, now, active.config, this.config.PARKING_PAY_MIN_MINUTES_LEFT);
    return {
      amountDueKopecks: result.amountDueKopecks,
      freeUntil: result.freeUntil.toISOString(),
      currentHourEndsAt: result.currentHourEndsAt.toISOString(),
      nextCharge: nextCharge
        ? {
            startsAt: nextCharge.startsAt.toISOString(),
            endsAt: nextCharge.endsAt.toISOString(),
            amountKopecks: nextCharge.amountKopecks,
          }
        : {
            startsAt: fallbackStart.toISOString(),
            endsAt: new Date(fallbackStart.getTime() + 60 * MINUTE_MS).toISOString(),
            amountKopecks: active.config.nextHourKopecks,
          },
      durationMinutes: Math.floor((now.getTime() - enteredAt.getTime()) / MINUTE_MS),
      breakdown: toChargeLines(result.breakdown),
      payNow: charge
        ? {
            amountKopecks: charge.amountKopecks,
            paidUntil: charge.paidUntil.toISOString(),
            includesNextHour: charge.includesNextHour,
          }
        : null,
      includesNextHour: charge?.includesNextHour ?? false,
      tariffVersion: active.version,
    };
  }
}
