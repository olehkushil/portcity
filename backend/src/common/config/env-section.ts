import type { FactoryProvider, InjectionToken } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from './config.tokens';
import { cleanEnv, formatZodIssues, type RawEnv } from './env.schema';

/**
 * Validates a module-specific slice of the environment.
 * Modules use this instead of editing the shared env schema, which avoids merge conflicts.
 *
 * Example:
 *   const parkingEnvSchema = z.object({ PARKING_PROVIDER: z.enum(['emulator', 'real']).default('emulator') });
 *   export const PARKING_CONFIG = Symbol('PARKING_CONFIG');
 *   providers: [envSectionProvider(PARKING_CONFIG, parkingEnvSchema, 'parking')]
 */
export function parseEnvSection<T extends z.ZodType>(
  schema: T,
  section: string,
  raw: RawEnv = process.env,
): z.output<T> {
  const parsed = schema.safeParse(cleanEnv(raw));
  if (!parsed.success) {
    throw new Error(
      `Invalid environment for section "${section}":\n${formatZodIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function envSectionProvider<T extends z.ZodType>(
  token: InjectionToken,
  schema: T,
  section: string,
): FactoryProvider<z.output<T>> {
  return {
    provide: token,
    // APP_CONFIG is injected only to guarantee that the root configuration (and .env loading)
    // has been initialised before the section is parsed.
    inject: [APP_CONFIG],
    useFactory: () => parseEnvSection(schema, section),
  };
}
