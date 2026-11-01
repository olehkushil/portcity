import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../common/config';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { Clock } from '../../../common/time/clock';
import { KYIV_TZ } from '../../../common/time/kyiv';
import type { HoursRange } from '../domain/mall-hours';
import {
  DEFAULT_MALL_HOURS,
  MALL_INFO_ID,
  type MallInfoDefaults,
  type MallInfoView,
  type StoredMallInfo,
  buildMallInfoView,
  effectiveMallHours,
} from '../domain/mall-info';
import type { MallInfoAdminDto, MallInfoDto, UpdateMallInfoDto } from '../dto/mall-info.dto';
import { CONTENT_CONFIG, type ContentConfig } from './content.config';
import { MallInfoRepository, type StoredMallInfoRow } from './mall-info.repository';
import type { AdminActor } from './types';

export { DEFAULT_MALL_HOURS };

/** How long the stored mall facts are served from memory (GET /mall/info, tenant cards). */
export const MALL_INFO_CACHE_MS = 30_000;

/** What tenant cards need to render: logo base URL, the mall hours and the moment. */
export interface TenantViewContext {
  logoBase: string | undefined;
  mallHours: HoursRange;
  now: Date;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GET /mall/info and PUT /admin/content/mall-info. Facts come from the singleton mall_info row
 * (edited in the back office, audited) and fall back to configuration: MALL_ADDRESS, MALL_HOURS,
 * SUPPORT_PHONE, SUPPORT_EMAIL (shared schema), MALL_WEBSITE and the parking hours (content
 * section). "Open now" is computed in Kyiv time. A database failure never breaks the endpoint:
 * the configuration answers alone.
 */
@Injectable()
export class MallInfoService {
  private readonly logger = new Logger(MallInfoService.name);
  private cache: { row: StoredMallInfoRow | null; at: number } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CONTENT_CONFIG) private readonly content: ContentConfig,
    private readonly clock: Clock,
    private readonly repo: MallInfoRepository,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  async getInfo(): Promise<MallInfoDto> {
    return this.view(await this.stored());
  }

  /** Back-office view: what is stored (null = configuration) plus the effective answer. */
  async getAdminView(): Promise<MallInfoAdminDto> {
    const row = await this.repo.find();
    return this.toAdminDto(row);
  }

  /** PUT /admin/content/mall-info: replaces the stored facts; audited `mall_info.update`. */
  async update(input: UpdateMallInfoDto, actor: AdminActor): Promise<MallInfoAdminDto> {
    const data = toStoredMallInfo(input);
    const now = this.clock.now();
    const row = await this.repo.transaction(async (tx) => {
      const before = await this.repo.find(tx);
      const saved = await this.repo.save(tx, data, actor.id, now);
      await this.audit.audit(
        {
          actor: { type: 'admin', id: actor.id },
          action: 'mall_info.update',
          entityType: 'mall_info',
          entityId: String(MALL_INFO_ID),
          before: before ? snapshot(before) : null,
          after: snapshot(saved),
          ip: actor.ip ?? null,
        },
        tx,
      );
      return saved;
    });
    this.cache = { row, at: this.clock.nowMs() };
    return this.toAdminDto(row);
  }

  /** Logo base, mall hours (stored, then MALL_HOURS) and the current moment for tenant cards. */
  async tenantViewContext(): Promise<TenantViewContext> {
    const row = await this.stored();
    return {
      logoBase: this.logoBaseUrl,
      mallHours: effectiveMallHours(row, this.config.MALL_HOURS),
      now: this.clock.now(),
    };
  }

  /** Base URL for tenant logos (content override, then the S3 public URL). */
  get logoBaseUrl(): string | undefined {
    return this.content.MALL_LOGO_BASE_URL ?? this.config.S3_PUBLIC_BASE_URL;
  }

  private defaults(): MallInfoDefaults {
    return {
      name: this.config.MALL_NAME,
      address: this.config.MALL_ADDRESS,
      website: this.content.MALL_WEBSITE,
      hours: this.config.MALL_HOURS,
      parkingUndergroundHours: this.content.MALL_PARKING_UNDERGROUND_HOURS,
      parkingSurfaceHours: this.content.MALL_PARKING_SURFACE_HOURS,
      supportPhone: this.config.SUPPORT_PHONE ?? null,
      supportEmail: this.config.SUPPORT_EMAIL ?? null,
    };
  }

  private view(row: StoredMallInfo | null): MallInfoView {
    return buildMallInfoView(row, this.defaults(), this.clock.now(), KYIV_TZ);
  }

  private async stored(): Promise<StoredMallInfoRow | null> {
    const nowMs = this.clock.nowMs();
    if (this.cache && nowMs - this.cache.at < MALL_INFO_CACHE_MS) {
      return this.cache.row;
    }
    try {
      const row = await this.repo.find();
      this.cache = { row, at: nowMs };
      return row;
    } catch (error) {
      this.logger.warn(`mall_info unavailable, answering from configuration: ${describe(error)}`);
      return this.cache?.row ?? null;
    }
  }

  private toAdminDto(row: StoredMallInfoRow | null): MallInfoAdminDto {
    return {
      address: row?.address ?? null,
      hours: row?.hours ?? null,
      telegramUrl: row?.telegramUrl ?? null,
      infoDesk: { location: row?.infoDeskLocation ?? null, hours: row?.infoDeskHours ?? null },
      parkingOperator: {
        name: row?.parkingOperatorName ?? null,
        phone: row?.parkingOperatorPhone ?? null,
        hours: row?.parkingOperatorHours ?? null,
      },
      rulesPdfUrl: row?.rulesPdfUrl ?? null,
      legalDocuments: row?.legalDocuments ?? [],
      floorMapUrls: row?.floorMapUrls ?? [],
      parkingMapUrl: row?.parkingMapUrl ?? null,
      support: { phone: row?.supportPhone ?? null, email: row?.supportEmail ?? null },
      updatedById: row?.updatedById ?? null,
      updatedAt: row?.updatedAt ?? null,
      effective: this.view(row),
    };
  }
}

/** PUT body -> stored columns (omitted or null -> null, i.e. configuration). */
export function toStoredMallInfo(input: UpdateMallInfoDto): StoredMallInfo {
  return {
    address: input.address ?? null,
    hours: input.hours ?? null,
    telegramUrl: input.telegramUrl ?? null,
    infoDeskLocation: input.infoDesk?.location ?? null,
    infoDeskHours: input.infoDesk?.hours ?? null,
    parkingOperatorName: input.parkingOperator?.name ?? null,
    parkingOperatorPhone: input.parkingOperator?.phone ?? null,
    parkingOperatorHours: input.parkingOperator?.hours ?? null,
    rulesPdfUrl: input.rulesPdfUrl ?? null,
    legalDocuments: (input.legalDocuments ?? []).map((doc) => ({
      key: doc.key,
      title: doc.title.trim(),
      url: doc.url,
    })),
    floorMapUrls: [...(input.floorMapUrls ?? [])]
      .map((map) => ({ floor: map.floor, url: map.url }))
      .sort((a, b) => a.floor - b.floor),
    parkingMapUrl: input.parkingMapUrl ?? null,
    supportPhone: input.support?.phone ?? null,
    supportEmail: input.support?.email ?? null,
  };
}

function snapshot(row: StoredMallInfo): Record<string, unknown> {
  return {
    address: row.address,
    hours: row.hours,
    telegramUrl: row.telegramUrl,
    infoDeskLocation: row.infoDeskLocation,
    infoDeskHours: row.infoDeskHours,
    parkingOperatorName: row.parkingOperatorName,
    parkingOperatorPhone: row.parkingOperatorPhone,
    parkingOperatorHours: row.parkingOperatorHours,
    rulesPdfUrl: row.rulesPdfUrl,
    legalDocuments: row.legalDocuments,
    floorMapUrls: row.floorMapUrls,
    parkingMapUrl: row.parkingMapUrl,
    supportPhone: row.supportPhone,
    supportEmail: row.supportEmail,
  };
}
