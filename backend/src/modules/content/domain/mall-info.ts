/**
 * Extended mall facts (singleton table mall_info) merged with configuration for GET /mall/info.
 * Pure module: no Nest, no Prisma. Never throws.
 */
import { type HoursRange, isOpenAt, parseHoursRange } from './mall-hours';

export const MAX_LEGAL_DOCUMENTS = 20;
export const MAX_FLOOR_MAPS = 20;
/** Primary key of the only mall_info row. */
export const MALL_INFO_ID = 1;

export interface LegalDocument {
  key: string;
  title: string;
  url: string;
}

export interface FloorMap {
  floor: number;
  url: string;
}

/** Columns of mall_info that an admin edits; null means "use configuration / not shown". */
export interface StoredMallInfo {
  address: string | null;
  hours: string | null;
  telegramUrl: string | null;
  infoDeskLocation: string | null;
  infoDeskHours: string | null;
  parkingOperatorName: string | null;
  parkingOperatorPhone: string | null;
  parkingOperatorHours: string | null;
  rulesPdfUrl: string | null;
  legalDocuments: LegalDocument[];
  floorMapUrls: FloorMap[];
  parkingMapUrl: string | null;
  supportPhone: string | null;
  supportEmail: string | null;
}

export const EMPTY_MALL_INFO: Readonly<StoredMallInfo> = Object.freeze({
  address: null,
  hours: null,
  telegramUrl: null,
  infoDeskLocation: null,
  infoDeskHours: null,
  parkingOperatorName: null,
  parkingOperatorPhone: null,
  parkingOperatorHours: null,
  rulesPdfUrl: null,
  legalDocuments: [],
  floorMapUrls: [],
  parkingMapUrl: null,
  supportPhone: null,
  supportEmail: null,
});

/** Configuration the stored facts fall back to (APP_CONFIG and the content env section). */
export interface MallInfoDefaults {
  name: string;
  address: string;
  website: string;
  hours: string | undefined;
  parkingUndergroundHours: string;
  parkingSurfaceHours: string;
  supportPhone: string | null;
  supportEmail: string | null;
}

export const DEFAULT_MALL_HOURS: HoursRange = Object.freeze({ from: '10:00', to: '22:00' });

export interface MallInfoView {
  name: string;
  address: string;
  website: string;
  timezone: string;
  hours: HoursRange & { isOpenNow: boolean };
  parking: { underground: HoursRange; surface: HoursRange };
  support: { phone: string | null; email: string | null };
  telegramUrl: string | null;
  infoDesk: { location: string | null; hours: string | null } | null;
  parkingOperator: { name: string | null; phone: string | null; hours: string | null } | null;
  rulesPdfUrl: string | null;
  legalDocuments: LegalDocument[];
  floorMapUrls: FloorMap[];
  parkingMapUrl: string | null;
  serverTime: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tolerant read of mall_info.legal_documents (malformed entries are dropped). */
export function readLegalDocuments(value: unknown): LegalDocument[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is LegalDocument =>
        isRecord(item) &&
        typeof item.key === 'string' &&
        typeof item.title === 'string' &&
        typeof item.url === 'string',
    )
    .slice(0, MAX_LEGAL_DOCUMENTS)
    .map((item) => ({ key: item.key, title: item.title, url: item.url }));
}

/** Tolerant read of mall_info.floor_map_urls, sorted by floor. */
export function readFloorMaps(value: unknown): FloorMap[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is FloorMap =>
        isRecord(item) && Number.isInteger(item.floor) && typeof item.url === 'string',
    )
    .slice(0, MAX_FLOOR_MAPS)
    .map((item) => ({ floor: item.floor, url: item.url }))
    .sort((a, b) => a.floor - b.floor);
}

/** Mall opening hours: stored value, then MALL_HOURS, then 10:00-22:00. */
export function effectiveMallHours(
  stored: Pick<StoredMallInfo, 'hours'> | null,
  configured: string | undefined,
): HoursRange {
  return parseHoursRange(stored?.hours) ?? parseHoursRange(configured) ?? DEFAULT_MALL_HOURS;
}

function nonEmpty(...values: Array<string | null>): boolean {
  return values.some((value) => value !== null && value.trim() !== '');
}

/** GET /mall/info: stored facts first, configuration for whatever is not stored. */
export function buildMallInfoView(
  stored: StoredMallInfo | null,
  defaults: MallInfoDefaults,
  now: Date,
  timezone: string,
): MallInfoView {
  const info = stored ?? EMPTY_MALL_INFO;
  const hours = effectiveMallHours(info, defaults.hours);
  return {
    name: defaults.name,
    address: info.address ?? defaults.address,
    website: defaults.website,
    timezone,
    hours: { ...hours, isOpenNow: isOpenAt(hours, now) },
    parking: {
      underground: parseHoursRange(defaults.parkingUndergroundHours) ?? hours,
      surface: parseHoursRange(defaults.parkingSurfaceHours) ?? hours,
    },
    support: {
      phone: info.supportPhone ?? defaults.supportPhone,
      email: info.supportEmail ?? defaults.supportEmail,
    },
    telegramUrl: info.telegramUrl,
    infoDesk: nonEmpty(info.infoDeskLocation, info.infoDeskHours)
      ? { location: info.infoDeskLocation, hours: info.infoDeskHours }
      : null,
    parkingOperator: nonEmpty(
      info.parkingOperatorName,
      info.parkingOperatorPhone,
      info.parkingOperatorHours,
    )
      ? {
          name: info.parkingOperatorName,
          phone: info.parkingOperatorPhone,
          hours: info.parkingOperatorHours,
        }
      : null,
    rulesPdfUrl: info.rulesPdfUrl,
    legalDocuments: info.legalDocuments,
    floorMapUrls: info.floorMapUrls,
    parkingMapUrl: info.parkingMapUrl,
    serverTime: now,
  };
}
