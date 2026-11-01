import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { z } from 'zod';
import { clubEnvSchema } from '../../modules/club/club.config';
import { contentEnvSchema } from '../../modules/content/services/content.config';
import { identityEnvSchema } from '../../modules/identity/identity.config';
import { mailEnvSchema } from '../../modules/notifications/services/mail/mail.config';
import { notificationsEnvSchema } from '../../modules/notifications/services/notifications.config';
import { parkingEnvSchema } from '../../modules/parking/parking.config';
import { paymentsEnvSchema } from '../../modules/payments/payments.config';
import { receiptsEnvSchema } from '../../modules/receipts/receipts.config';
import { rewardsEnvSchema } from '../../modules/rewards/rewards.config';
import { idempotencyEnvSchema } from '../idempotency/idempotency.config';
import { SHARED_ENV_KEYS, cleanEnv, envSchema, validateEnv } from './env.schema';
import { isSecretKey } from './secret-policy';

/**
 * Integration check for `.env.example`: it documents every variable of the shared schema and of
 * every module env section, and its development defaults pass all of those schemas.
 */
function readEnvExample(): Record<string, string> {
  const text = readFileSync(resolve(__dirname, '../../../.env.example'), 'utf8');
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`.env.example: cannot parse line "${line}"`);
    }
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

/** Every env section registered with envSectionProvider (src/common/config/env-section.ts). */
const SECTIONS: ReadonlyArray<[string, z.ZodObject]> = [
  ['idempotency', idempotencyEnvSchema],
  ['identity', identityEnvSchema],
  ['club', clubEnvSchema],
  ['content', contentEnvSchema],
  ['receipts', receiptsEnvSchema],
  ['rewards', rewardsEnvSchema],
  ['parking', parkingEnvSchema],
  ['payments', paymentsEnvSchema],
  ['notifications', notificationsEnvSchema],
  ['mail', mailEnvSchema],
];

/** Seed-only variables (prisma/seed.ts reads them; no runtime schema). */
const SEED_ONLY_KEYS = ['SEED_VALIDATOR_KEY', 'SEED_VALIDATOR_PIN', 'SEED_ADMIN_TOTP_SECRET'];

/** Section names passed to envSectionProvider(token, schema, '<name>') anywhere in src/. */
function registeredSectionNames(): string[] {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/envSectionProvider\(\s*\w+,\s*\w+,\s*'([a-z-]+)'/g)) {
          names.add(match[1] as string);
        }
      }
    }
  };
  walk(resolve(__dirname, '../..'));
  return [...names].sort();
}

describe('.env.example', () => {
  const example = readEnvExample();

  it('covers every env section registered in src/', () => {
    expect(registeredSectionNames()).toEqual(SECTIONS.map(([name]) => name).sort());
  });

  it('lists every shared variable', () => {
    expect(SHARED_ENV_KEYS.filter((key) => !(key in example))).toEqual([]);
  });

  it.each(SECTIONS)('lists every variable of the %s section', (_name, schema) => {
    expect(Object.keys(schema.shape).filter((key) => !(key in example))).toEqual([]);
  });

  it('documents nothing that no schema reads', () => {
    const known = new Set<string>([
      ...SHARED_ENV_KEYS,
      ...SECTIONS.flatMap(([, schema]) => Object.keys(schema.shape)),
      ...SEED_ONLY_KEYS,
    ]);
    expect(Object.keys(example).filter((key) => !known.has(key))).toEqual([]);
  });

  it('holds development defaults that every schema accepts', () => {
    const env = { ...example, NODE_ENV: 'development' };
    expect(envSchema.safeParse(cleanEnv(env)).success).toBe(true);
    for (const [name, schema] of SECTIONS) {
      const parsed = schema.safeParse(cleanEnv(env));
      expect({ name, ok: parsed.success, issues: parsed.error?.issues ?? [] }).toEqual({
        name,
        ok: true,
        issues: [],
      });
    }
  });

  it('is refused as is in production (development secrets and adapters)', () => {
    const env = { ...example, NODE_ENV: 'production' };
    expect(envSchema.safeParse(cleanEnv(env)).success).toBe(false);
    expect(identityEnvSchema.safeParse(cleanEnv(env)).success).toBe(false);
    expect(parkingEnvSchema.safeParse(cleanEnv(env)).success).toBe(false);
    expect(paymentsEnvSchema.safeParse(cleanEnv(env)).success).toBe(false);
  });

  it('names every development secret it ships when started in production', () => {
    const secrets = Object.entries(example)
      .filter(([key, value]) => isSecretKey(key) && value !== '')
      .map(([key]) => key);
    expect(secrets).toEqual(expect.arrayContaining(['JWT_SECRET', 'PAYMENTS_RECEIPT_QR_SECRET']));
    const message = startupError({ ...example, NODE_ENV: 'production' });
    expect(secrets.filter((key) => !message.includes(`${key}:`))).toEqual([]);
  });
});

/**
 * `KEY: value` lines of the shared `x-app-env` block of docker-compose.yml, with
 * `${KEY:-default}` resolved to its default (what runs when nothing is exported).
 */
function readComposeAppEnv(): Record<string, string> {
  const lines = readFileSync(resolve(__dirname, '../../../docker-compose.yml'), 'utf8').split(
    /\r?\n/,
  );
  const start = lines.findIndex((line) => line.startsWith('x-app-env:'));
  const result: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) {
      break;
    }
    const match = /^\s+([A-Z0-9_]+):\s*(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const value = (match[2] as string).replace(/^"(.*)"$/, '$1');
    const fallback = /^\$\{[A-Z0-9_]+:-(.*)\}$/.exec(value);
    result[match[1] as string] = fallback ? (fallback[1] ?? '') : value;
  }
  return result;
}

/** Message of the error validateEnv throws for `env`, or '' when it is accepted. */
function startupError(env: Record<string, string>): string {
  try {
    validateEnv(env);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('docker-compose.yml app environment', () => {
  const compose = readComposeAppEnv();

  it('is the local demo: development secrets and adapters', () => {
    expect(compose).toMatchObject({ NODE_ENV: 'development', JWT_SECRET: expect.any(String) });
  });

  it('passes every schema in development', () => {
    const env = cleanEnv({ ...compose, APP_MODE: 'api' });
    const shared = envSchema.safeParse(env);
    expect(shared.error?.issues ?? []).toEqual([]);
    for (const [name, schema] of SECTIONS) {
      const parsed = schema.safeParse(env);
      expect({ name, issues: parsed.error?.issues ?? [] }).toEqual({ name, issues: [] });
    }
  });

  it('is refused in production, naming its compose-only secrets', () => {
    const message = startupError({ ...compose, NODE_ENV: 'production', APP_MODE: 'api' });
    for (const key of ['JWT_SECRET', 'OTP_PEPPER', 'VOUCHER_PEPPER', 'MEMBER_QR_SECRET']) {
      expect(message).toContain(`${key}:`);
    }
    expect(
      paymentsEnvSchema.safeParse(cleanEnv({ ...compose, NODE_ENV: 'production' })).success,
    ).toBe(false);
  });
});
