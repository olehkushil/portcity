import { z } from 'zod';
import { DEFAULT_PARKING_TARIFF } from '../../../common/contracts/parking';
import { HOURS_RANGE_PATTERN } from '../domain/mall-hours';

/**
 * Content-specific environment slice (FOUNDATION_SUMMARY section 8): validated by
 * `envSectionProvider(CONTENT_CONFIG, contentEnvSchema, 'content')` next to the shared
 * APP_CONFIG (which already carries MALL_NAME, MALL_ADDRESS, MALL_HOURS, SUPPORT_PHONE,
 * SUPPORT_EMAIL and S3_PUBLIC_BASE_URL). Documented in src/modules/content/README.md.
 */
export const CONTENT_CONFIG = Symbol('CONTENT_CONFIG');

const hoursRange = z.string().regex(HOURS_RANGE_PATTERN, 'expected HH:mm-HH:mm');

export const contentEnvSchema = z.object({
  /** Public site of the mall, returned by GET /mall/info. */
  MALL_WEBSITE: z.url().default('https://portcity.com.ua'),
  /** Opening hours of the parking zones (informational; the tariff config is owned by parking). */
  MALL_PARKING_UNDERGROUND_HOURS: hoursRange.default(DEFAULT_PARKING_TARIFF.undergroundHours),
  MALL_PARKING_SURFACE_HOURS: hoursRange.default(DEFAULT_PARKING_TARIFF.surfaceHours),
  /** Base URL for tenant logos; defaults to S3_PUBLIC_BASE_URL when unset. */
  MALL_LOGO_BASE_URL: z.url().optional(),
});

export type ContentConfig = z.output<typeof contentEnvSchema>;
