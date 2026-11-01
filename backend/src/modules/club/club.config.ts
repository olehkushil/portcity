import { z } from 'zod';
import { envSectionProvider } from '../../common/config/env-section';

/**
 * Club-specific environment (validated separately from the shared schema, see
 * docs/FOUNDATION_SUMMARY.md section 8). Documented in src/modules/club/README.md.
 */
export const CLUB_CONFIG = Symbol('CLUB_CONFIG');

export const clubEnvSchema = z.object({
  /** Points for each profile field the member fills in (user.profile_field_completed). */
  PROFILE_BONUS_PER_FIELD: z.coerce.number().int().min(0).max(1000).default(10),
  /** Extra points once every profile field is filled (completedAll = true). */
  PROFILE_BONUS_COMPLETE: z.coerce.number().int().min(0).max(1000).default(20),
});

export type ClubConfig = z.output<typeof clubEnvSchema>;

export const DEFAULT_CLUB_CONFIG: ClubConfig = Object.freeze(clubEnvSchema.parse({}));

export const clubConfigProvider = envSectionProvider(CLUB_CONFIG, clubEnvSchema, 'club');
