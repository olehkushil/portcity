import { z } from 'zod';
import {
  DEFAULT_PARKING_TARIFF,
  type ParkingTariffConfig,
} from '../../../common/contracts/parking';

const HHMM = /^(?:[01]?\d|2[0-4]):[0-5]\d$/;
const HOURS_RANGE = /^(?:[01]?\d|2[0-4]):[0-5]\d-(?:[01]?\d|2[0-4]):[0-5]\d$/;
const kopecks = z.number().int().min(0).max(100_000_000);

/** Validates `ParkingTariff.config` (brief section 4). */
export const tariffConfigSchema = z.object({
  freeMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
  firstHourKopecks: kopecks,
  nextHourKopecks: kopecks,
  nightWindow: z.object({
    from: z.string().regex(HHMM),
    to: z.string().regex(HHMM),
    hourKopecks: kopecks,
  }),
  lostTicketKopecks: kopecks,
  exitGraceMinutes: z.number().int().min(0).max(120),
  undergroundHours: z.string().regex(HOURS_RANGE),
  surfaceHours: z.string().regex(HOURS_RANGE),
});

export type TariffConfigIssue = { path: string; message: string };

export type TariffConfigParseResult =
  { ok: true; config: ParkingTariffConfig } | { ok: false; issues: TariffConfigIssue[] };

/** Parses an unknown JSON value (database column or admin input) into a tariff config. */
export function parseTariffConfig(value: unknown): TariffConfigParseResult {
  const parsed = tariffConfigSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/** Falls back to the default tariff when the stored JSON is unusable. */
export function tariffConfigOrDefault(value: unknown): ParkingTariffConfig {
  const parsed = parseTariffConfig(value);
  return parsed.ok ? parsed.config : { ...DEFAULT_PARKING_TARIFF };
}
