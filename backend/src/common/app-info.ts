import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_NAME = 'portcity-backend';
export const API_PREFIX = 'api/v1';

let cachedVersion: string | undefined;

/** Version from package.json (works from src/ via ts-node and from dist/ in the container). */
export function appVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  const candidates = [
    join(__dirname, '..', '..', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') {
        cachedVersion = parsed.version;
        return cachedVersion;
      }
    } catch {
      // try the next location
    }
  }
  cachedVersion = process.env.npm_package_version ?? '0.0.0';
  return cachedVersion;
}
