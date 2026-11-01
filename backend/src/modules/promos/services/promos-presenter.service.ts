import { Inject, Injectable } from '@nestjs/common';
import type { Event } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import {
  FEATURE_FLAGS_PORT,
  FEATURE_FLAG_KEYS,
  type FeatureFlagsPort,
} from '../../../common/contracts/admin';
import { CONTENT_PORT, type ContentPort } from '../../../common/contracts/content';
import { maxPersonsFromFlagPayload } from '../domain/event-rules';
import { publicImageUrl } from '../domain/image-url';
import type { EventDto, RegistrationDto } from '../dto/event.dto';
import type { PromoDto, PromoTenantDto } from '../dto/promo.dto';
import {
  type PresentationContext,
  type PromoWithTemplate,
  nonNull,
  toEventDto,
  toPromoDto,
  toPromoTenantDto,
} from './mappers';

/** The `events.registration` flag as the registration rules and the event cards see it. */
export interface RegistrationSettings {
  /** Missing flag row means enabled. */
  enabled: boolean;
  /** `maxPersonsPerRegistration` from the flag payload; null means 4. */
  defaultMaxPersons: number | null;
}

/**
 * Builds promo and event responses: tenant cards (CONTENT_PORT, one batch per page), public
 * image URLs (S3_PUBLIC_BASE_URL + key) and the persons limit default from the
 * `events.registration` flag payload. Shared by the member and the back-office services.
 */
@Injectable()
export class PromosPresenter {
  private readonly imageBaseUrl: string | null;

  constructor(
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'S3_PUBLIC_BASE_URL'>,
    @Inject(CONTENT_PORT) private readonly content: ContentPort,
    @Inject(FEATURE_FLAGS_PORT) private readonly flags: FeatureFlagsPort,
  ) {
    this.imageBaseUrl = config.S3_PUBLIC_BASE_URL ?? null;
  }

  imageUrl(key: string | null): string | null {
    return publicImageUrl(this.imageBaseUrl, key);
  }

  async registrationSettings(): Promise<RegistrationSettings> {
    const flag = await this.flags.get(FEATURE_FLAG_KEYS.eventsRegistration);
    return {
      enabled: flag ? flag.enabled : true,
      defaultMaxPersons: maxPersonsFromFlagPayload(flag?.payload ?? null),
    };
  }

  async tenant(tenantId: string | null): Promise<PromoTenantDto | null> {
    if (!tenantId) {
      return null;
    }
    const tenant = await this.content.getTenant(tenantId);
    return tenant ? toPromoTenantDto(tenant) : null;
  }

  async tenantMap(tenantIds: Array<string | null>): Promise<Map<string, PromoTenantDto>> {
    const unique = [...new Set(tenantIds.filter(nonNull))];
    if (unique.length === 0) {
      return new Map();
    }
    const tenants = await this.content.getTenants(unique);
    return new Map(tenants.map((tenant) => [tenant.id, toPromoTenantDto(tenant)]));
  }

  promoView(now: Date): PresentationContext {
    return { now, imageBaseUrl: this.imageBaseUrl };
  }

  async promoDtos(rows: PromoWithTemplate[], now: Date): Promise<PromoDto[]> {
    const tenants = await this.tenantMap(rows.map((row) => row.tenantId));
    const view = this.promoView(now);
    return rows.map((row) =>
      toPromoDto(row, row.tenantId ? (tenants.get(row.tenantId) ?? null) : null, view),
    );
  }

  async promoDto(row: PromoWithTemplate, now: Date): Promise<PromoDto> {
    return toPromoDto(row, await this.tenant(row.tenantId), this.promoView(now));
  }

  async eventView(now: Date): Promise<PresentationContext> {
    const settings = await this.registrationSettings();
    return { now, imageBaseUrl: this.imageBaseUrl, defaultMaxPersons: settings.defaultMaxPersons };
  }

  /** `registrationOf` returns the caller's registration of an event (null for guests). */
  async eventDtos(
    rows: Event[],
    now: Date,
    registrationOf: (row: Event) => RegistrationDto | null = () => null,
  ): Promise<EventDto[]> {
    const [tenants, view] = await Promise.all([
      this.tenantMap(rows.map((row) => row.tenantId)),
      this.eventView(now),
    ]);
    return rows.map((row) =>
      toEventDto(
        row,
        view,
        registrationOf(row),
        row.tenantId ? (tenants.get(row.tenantId) ?? null) : null,
      ),
    );
  }

  async eventDto(
    row: Event,
    now: Date,
    registration: RegistrationDto | null = null,
  ): Promise<EventDto> {
    const [tenant, view] = await Promise.all([this.tenant(row.tenantId), this.eventView(now)]);
    return toEventDto(row, view, registration, tenant);
  }
}
