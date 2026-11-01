/**
 * Database seed (BRIEF section 11).
 *
 * Idempotent: every row is upserted either by a natural unique key (slug, fn, phone, email,
 * version, idempotency key, (fn, fiscalId)) or by a stable seed id derived from a name, so the
 * script can run any number of times against the same database.
 *
 * Credentials are written only when the row is created: re-running the seed never changes the
 * admin's password hash, role, active flag or TOTP secret, nor the validator device's PIN, key or
 * active flag (security review 2026-11-01). Change them through the back office instead.
 *
 * Environment:
 *   DATABASE_URL               required by Prisma
 *   NODE_ENV                   with `production` the seed refuses to run unless SEED_ADMIN_PASSWORD,
 *                              SEED_VALIDATOR_KEY and SEED_VALIDATOR_PIN are set to non-default values
 *   SEED_ADMIN_PASSWORD        password of admin@portcity.local when it is created (development
 *                              default ChangeMe-2026!, printed as a warning; production: required,
 *                              at least 12 characters, not a default from the repository)
 *   SEED_ADMIN_TOTP_SECRET     optional base32 TOTP secret of the admin for a development demo stand
 *                              (refused in production: the owner enrols TOTP at the first login)
 *   SEED_VALIDATOR_KEY         device key of the demo validator device (development default
 *                              dev-validator-aroma-kava; production: at least 32 characters)
 *   SEED_VALIDATOR_PIN         shift PIN of the demo validator device, 6-12 digits (development
 *                              default 246813)
 *   PARKING_EMULATOR_SCENARIO  free | payable | paid | closed (default payable): shape of the demo parking session
 */

import { createHash } from 'node:crypto';
import {
  Prisma,
  PrismaClient,
  type ParkingSessionStatus,
  type PointsSourceType,
  type PointsTxState,
  type PointsTxType,
  type ReceiptStatus,
  type RewardKind,
} from '@prisma/client';
import { uuidv7 } from 'uuidv7';
// Pure helpers (no Nest, no Prisma). The seed hashes credentials with the application's own
// scrypt parameters, validates PINs, secrets and tenant hours with the application's rules and
// computes expiry dates and bucket days exactly like the ledger (Kyiv wall-clock months, Kyiv
// calendar day of expiresAt).
import {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_SCRYPT_PARAMS,
  hashPassword,
} from '../src/common/auth/crypto';
import { MIN_PRODUCTION_SECRET_LENGTH, isDeniedSecret } from '../src/common/config/secret-policy';
import { PROFILE_FIELDS } from '../src/common/contracts/identity';
import { bucketDayKey, computeExpiresAt, dayKeyToDate } from '../src/modules/club/domain/expiry';
import { type TenantHours, parseTenantHours } from '../src/modules/content/domain/tenant-hours';
import { NEW_PIN_PATTERN } from '../src/modules/rewards/domain/validator-pin';

const prisma = new PrismaClient();

const DEFAULT_ADMIN_PASSWORD = 'ChangeMe-2026!';
const DEFAULT_VALIDATOR_KEY = 'dev-validator-aroma-kava';
const DEFAULT_VALIDATOR_PIN = '246813';
/** Same minimum as a back-office password change (identity admin DTO). */
const MIN_ADMIN_PASSWORD_LENGTH = 12;
/** Base32 TOTP secret as authenticator apps accept it (otplib generates 32 characters). */
const TOTP_SECRET_PATTERN = /^[A-Z2-7]{16,64}$/;
const ADMIN_EMAIL = 'admin@portcity.local';
const DEMO_PHONE = '+380501234567';
const DEMO_MEMBER_CODE = '734211800';
const DEMO_PLATE = 'AC1234BC';
const KYIV_TZ = 'Europe/Kyiv';
/** Fixed timestamp part of every stable seed id (2026-01-01T00:00:00Z). */
const SEED_EPOCH_MS = Date.UTC(2026, 0, 1);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID v7 for seed rows without a natural key: fixed timestamp, hash-derived random bits. */
function seedId(name: string): string {
  const hash = createHash('sha256').update(`portcity-seed:${name}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 10));
  bytes[0] = 0x70 | (bytes.readUInt8(0) & 0x0f); // version 7
  bytes[2] = 0x80 | (bytes.readUInt8(2) & 0x3f); // RFC 4122 variant
  const ts = SEED_EPOCH_MS.toString(16).padStart(12, '0');
  const hex = bytes.toString('hex');
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 20)}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Kyiv wall-clock components of an instant (Node ships full ICU). */
function kyivWallClock(at: Date): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function kyivOffsetMs(at: Date): number {
  const w = kyivWallClock(at);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instant for a Kyiv wall-clock time; month is 1-based, day may overflow (Date.UTC semantics). */
function kyiv(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = naive - kyivOffsetMs(new Date(naive));
  return new Date(naive - kyivOffsetMs(new Date(firstGuess)));
}

/** QR text of the tax service for a receipt, as the parser expects it. */
function taxQrUrl(fn: string, fiscalId: string, issuedAt: Date, totalKopecks: number): string {
  const w = kyivWallClock(issuedAt);
  const date = `${w.year}${pad2(w.month)}${pad2(w.day)}`;
  const time = `${pad2(w.hour)}${pad2(w.minute)}${pad2(w.second)}`;
  const sum = (totalKopecks / 100).toFixed(2);
  return `https://cabinet.tax.gov.ua/cashregs/check?fn=${fn}&id=${fiscalId}&date=${date}&time=${time}&sm=${sum}`;
}

function requireId(map: Map<string, string>, key: string): string {
  const id = map.get(key);
  if (id === undefined) {
    throw new Error(`[seed] missing seed reference: ${key}`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

/** Program rules v1 (development plan 12.2, BRIEF section 4). */
const RULE_SET_V1 = {
  baseRatePercent: 3,
  maxPointsPerReceipt: 500,
  minReceiptTotalKopecks: 0,
  dailyReceiptLimit: 10,
  autoApproveThresholdKopecks: 100000,
  holdThresholdKopecks: 300000,
  holdDays: 7,
  uploadWindowDays: 7,
  pointsTtlMonths: 12,
  newcomerLockHours: 72,
  // Profile bonuses follow the prototype (product decision 2026-11-01): club pays
  // PROFILE_BONUS_PER_FIELD (10) per filled field and PROFILE_BONUS_COMPLETE (20) for a complete
  // profile from user.profile_field_completed, so the single welcome bonus for a completed
  // profile is 0 (no double payment). Registration 50 and first receipt 20 stay.
  welcome: { register: 50, profile: 0, firstReceipt: 20 },
  pointValueKopecks: 100,
  expiryReminderDays: [30, 7],
} satisfies Prisma.InputJsonObject;

/** Parking tariff v1 from the operator's rules (BRIEF section 4). */
const TARIFF_V1 = {
  freeMinutes: 30,
  firstHourKopecks: 2000,
  nextHourKopecks: 4000,
  nightWindow: { from: '00:00', to: '05:00', hourKopecks: 50000 },
  lostTicketKopecks: 50000,
  exitGraceMinutes: 0,
  undergroundHours: '08:00-21:00',
  surfaceHours: '05:00-24:00',
} satisfies Prisma.InputJsonObject;

interface TenantSeed {
  slug: string;
  name: string;
  category: string;
  floor: number | null;
  participates?: boolean;
  excludedFromProgram?: boolean;
  ratePercentOverride?: number;
  website?: string;
  /** Fake 10-digit cash register fiscal numbers, status active. */
  fns: readonly string[];
  /**
   * Weekly hours (Kyiv time, content/domain/tenant-hours.ts); null = the mall hours every day.
   * A day without a key also falls back to the mall hours, `[]` means closed.
   */
  hours: TenantHours | null;
  locationText: string;
  /** Floor map image (placeholder URL until the real files exist; `mall/` is a public prefix). */
  mapImageUrl: string;
}

/** The same ranges every day of the week. */
function everyDay(range: string): TenantHours {
  return {
    mon: [range],
    tue: [range],
    wed: [range],
    thu: [range],
    fri: [range],
    sat: [range],
    sun: [range],
  };
}

const FLOOR_MAP = (floor: number): string => `https://cdn.portcity.com.ua/mall/floor-${floor}.png`;

const TENANTS: readonly TenantSeed[] = [
  {
    slug: 'intertop',
    name: 'INTERTOP',
    category: 'fashion',
    floor: 1,
    website: 'https://intertop.ua',
    fns: ['4000100011', '4000100012'],
    // Mall hours on ordinary days, a short day on 31 December.
    hours: {
      exceptions: [{ date: '2026-12-31', ranges: ['10:00-18:00'], note: 'Передноворічний день' }],
    },
    locationText: '1 поверх, ліворуч від центрального входу',
    mapImageUrl: FLOOR_MAP(1),
  },
  {
    slug: 'aroma-kava',
    name: 'Aroma Kava',
    category: 'coffee',
    floor: 1,
    fns: ['4000100021', '4000100022'],
    hours: {
      mon: ['08:00-22:00'],
      tue: ['08:00-22:00'],
      wed: ['08:00-22:00'],
      thu: ['08:00-22:00'],
      fri: ['08:00-22:00'],
      sat: ['09:00-22:00'],
      sun: ['09:00-22:00'],
    },
    locationText: '1 поверх, біля центрального входу',
    mapImageUrl: FLOOR_MAP(1),
  },
  {
    slug: 'coffee-gelato',
    name: 'Coffee & Gelato',
    category: 'coffee',
    floor: 2,
    fns: ['4000100031', '4000100032'],
    hours: null,
    locationText: '2 поверх, біля ескалатора',
    mapImageUrl: FLOOR_MAP(2),
  },
  {
    slug: 'premier-city',
    name: 'Premier City',
    category: 'cinema',
    floor: 3,
    fns: ['4000100041', '4000100042'],
    hours: {
      mon: ['10:00-24:00'],
      tue: ['10:00-24:00'],
      wed: ['10:00-24:00'],
      thu: ['10:00-24:00'],
      fri: ['10:00-01:00'],
      sat: ['10:00-01:00'],
      sun: ['10:00-24:00'],
    },
    locationText: '3 поверх, кінотеатр',
    mapImageUrl: FLOOR_MAP(3),
  },
  {
    slug: 'strike-city',
    name: 'Strike City',
    category: 'bowling',
    floor: 3,
    fns: ['4000100051', '4000100052'],
    hours: {
      mon: ['12:00-24:00'],
      tue: ['12:00-24:00'],
      wed: ['12:00-24:00'],
      thu: ['12:00-24:00'],
      fri: ['12:00-02:00'],
      sat: ['11:00-02:00'],
      sun: ['11:00-24:00'],
    },
    locationText: '3 поверх, праворуч від кінотеатру',
    mapImageUrl: FLOOR_MAP(3),
  },
  {
    slug: 'generator-city',
    name: 'Generator City',
    category: 'entertainment',
    floor: 3,
    fns: ['4000100061', '4000100062'],
    hours: {
      mon: ['11:00-22:00'],
      tue: ['11:00-22:00'],
      wed: ['11:00-22:00'],
      thu: ['11:00-22:00'],
      fri: ['11:00-23:00'],
      sat: ['10:00-23:00'],
      sun: ['10:00-22:00'],
    },
    locationText: '3 поверх, ігрова зона',
    mapImageUrl: FLOOR_MAP(3),
  },
  {
    slug: 'figli-migli',
    name: 'Figli Migli',
    category: 'kids',
    floor: 3,
    fns: ['4000100071', '4000100072'],
    hours: everyDay('10:00-21:00'),
    locationText: '3 поверх, дитяча зона',
    mapImageUrl: FLOOR_MAP(3),
  },
  // Hypermarket: present in the directory, excluded from the points program (one active fn so the rule is testable).
  {
    slug: 'tamtam',
    name: 'ТамТам',
    category: 'hypermarket',
    floor: 0,
    participates: false,
    excludedFromProgram: true,
    fns: ['4000100081'],
    hours: everyDay('08:00-23:00'),
    locationText: 'цокольний поверх, гіпермаркет',
    mapImageUrl: FLOOR_MAP(0),
  },
  {
    slug: 'sport-point',
    name: 'Sport Point',
    category: 'sport',
    floor: 2,
    fns: ['4000100091', '4000100092'],
    hours: null,
    locationText: '2 поверх, галерея',
    mapImageUrl: FLOOR_MAP(2),
  },
  {
    slug: 'techno-hub',
    name: 'Техно Хаб',
    category: 'electronics',
    floor: 2,
    fns: ['4000100101', '4000100102'],
    hours: null,
    locationText: '2 поверх, біля фуд-корту',
    mapImageUrl: FLOOR_MAP(2),
  },
  {
    slug: 'beauty-room',
    name: 'Beauty Room',
    category: 'beauty',
    floor: 1,
    fns: ['4000100111', '4000100112'],
    // Closed on Sundays.
    hours: {
      mon: ['10:00-21:00'],
      tue: ['10:00-21:00'],
      wed: ['10:00-21:00'],
      thu: ['10:00-21:00'],
      fri: ['10:00-21:00'],
      sat: ['10:00-20:00'],
      sun: [],
    },
    locationText: '1 поверх, праве крило',
    mapImageUrl: FLOOR_MAP(1),
  },
  {
    slug: 'apteka-24',
    name: 'Аптека 24',
    category: 'pharmacy',
    floor: 0,
    fns: ['4000100121', '4000100122'],
    hours: everyDay('00:00-24:00'),
    locationText: 'цокольний поверх, окремий вхід з вулиці',
    mapImageUrl: FLOOR_MAP(0),
  },
  {
    slug: 'home-comfort',
    name: 'Home Comfort',
    category: 'home',
    floor: 2,
    fns: ['4000100131', '4000100132'],
    hours: null,
    locationText: '2 поверх, ліве крило',
    mapImageUrl: FLOOR_MAP(2),
  },
  {
    slug: 'food-court',
    name: 'Фуд-корт',
    category: 'food_court',
    floor: 3,
    fns: ['4000100141', '4000100142'],
    hours: {
      mon: ['10:00-22:00'],
      tue: ['10:00-22:00'],
      wed: ['10:00-22:00'],
      thu: ['10:00-22:00'],
      fri: ['10:00-23:00'],
      sat: ['10:00-23:00'],
      sun: ['10:00-22:00'],
    },
    locationText: '3 поверх, фуд-корт',
    mapImageUrl: FLOOR_MAP(3),
  },
];

/** Singleton mall_info row (id = 1); null fields fall back to MALL_ADDRESS, SUPPORT_* config. */
const MALL_INFO = {
  address: null,
  hours: '10:00-22:00',
  telegramUrl: 'https://t.me/portcity_lutsk',
  infoDeskLocation: '1 поверх, центральний вхід',
  infoDeskHours: '10:00-22:00',
  parkingOperatorName: 'Оператор паркінгу ТРЦ «Порт City»',
  parkingOperatorPhone: '+380332000100',
  parkingOperatorHours: 'цілодобово',
  rulesPdfUrl: 'https://portcity.com.ua/docs/pravyla-trc.pdf',
  legalDocuments: [
    {
      key: 'program_rules',
      title: 'Правила програми лояльності',
      url: 'https://portcity.com.ua/docs/loyalty-rules.pdf',
    },
    {
      key: 'privacy',
      title: 'Політика конфіденційності',
      url: 'https://portcity.com.ua/docs/privacy.pdf',
    },
    {
      key: 'parking_rules',
      title: 'Правила користування паркінгом',
      url: 'https://portcity.com.ua/docs/parking-rules.pdf',
    },
  ],
  floorMapUrls: [0, 1, 2, 3].map((floor) => ({ floor, url: FLOOR_MAP(floor) })),
  parkingMapUrl: 'https://cdn.portcity.com.ua/mall/parking.png',
  supportPhone: null,
  supportEmail: null,
} satisfies Prisma.MallInfoUncheckedUpdateInput;

interface RewardSeed {
  key: string;
  title: string;
  description: string;
  costPoints: number;
  kind: RewardKind;
  tenantSlug: string | null;
  perUserLimit: number | null;
  sortOrder: number;
}

const REWARDS: readonly RewardSeed[] = [
  {
    key: 'parking-hour',
    title: 'Година паркінгу',
    description: 'Одна година паркування на підземному або наземному паркінгу Порт City.',
    costPoints: 40,
    kind: 'parking_hour',
    tenantSlug: null,
    perUserLimit: null,
    sortOrder: 10,
  },
  {
    key: 'coffee-to-go',
    title: 'Кава з собою',
    description: 'Будь-яка кава з собою в Aroma Kava.',
    costPoints: 60,
    kind: 'partner',
    tenantSlug: 'aroma-kava',
    perUserLimit: 5,
    sortOrder: 20,
  },
  {
    key: 'popcorn',
    title: 'Попкорн у Premier City',
    description: 'Середній попкорн у кінотеатрі Premier City.',
    costPoints: 80,
    kind: 'partner',
    tenantSlug: 'premier-city',
    perUserLimit: null,
    sortOrder: 30,
  },
  {
    key: 'figli-migli-15',
    title: '15 хвилин у Figli Migli',
    description: '15 хвилин у дитячому розважальному центрі Figli Migli.',
    costPoints: 50,
    kind: 'partner',
    tenantSlug: 'figli-migli',
    perUserLimit: null,
    sortOrder: 40,
  },
  {
    key: 'gift-card-200',
    title: 'Подарункова карта 200 ₴',
    description: 'Подарункова карта Порт City номіналом 200 грн.',
    costPoints: 200,
    kind: 'certificate',
    tenantSlug: null,
    perUserLimit: 2,
    sortOrder: 50,
  },
  {
    key: 'cinema-ticket',
    title: 'Квиток у кіно',
    description: 'Квиток на будь-який 2D-сеанс у Premier City.',
    costPoints: 450,
    kind: 'cinema',
    tenantSlug: 'premier-city',
    perUserLimit: null,
    sortOrder: 60,
  },
];

const FEATURE_FLAGS = [
  {
    key: 'parking.info_mode',
    enabled: true,
    payload: { note: 'Timer mode until the parking provider integration is live' },
  },
  { key: 'receipts.manual_submission', enabled: true, payload: { maxPhotoBytes: 5_000_000 } },
  // Default for events without their own maxPersonsPerRegistration; 4 as in the prototype
  // («До 4 учасників на одну реєстрацію», product decision 2026-11-01).
  { key: 'events.registration', enabled: true, payload: { maxPersonsPerRegistration: 4 } },
  {
    // Design brief 4.3: the duty officer switches it on during an air-raid alert (entry closed,
    // exit free in the first 30 minutes). Seeded disabled so it is visible in the back office.
    key: 'parking.air_raid',
    enabled: false,
    payload: {
      note: 'Duty officer switches it on during an air-raid alert; startedAt optional',
      freeExitMinutes: 30,
    },
  },
] as const;

type Scenario = 'free' | 'payable' | 'paid' | 'closed';

function readScenario(): Scenario {
  const raw = (process.env.PARKING_EMULATOR_SCENARIO ?? 'payable').toLowerCase();
  if (raw === 'free' || raw === 'payable' || raw === 'paid' || raw === 'closed') {
    return raw;
  }
  console.warn(`[seed] unknown PARKING_EMULATOR_SCENARIO "${raw}", falling back to "payable"`);
  return 'payable';
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface SeedCredentials {
  adminPassword: string;
  /** Base32, upper case; null = the owner enrols TOTP at the first login. */
  adminTotpSecret: string | null;
  validatorKey: string;
  validatorPin: string;
}

/** Trimmed value of an environment variable; empty means unset. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Seed credentials from the environment. In production every credential must be given
 * explicitly and must not be a default published in the repository (secret-policy.ts); a fixed
 * TOTP secret is refused there. Throws with every problem listed, never echoing the values.
 */
function readSeedCredentials(env: NodeJS.ProcessEnv): SeedCredentials {
  const production = env.NODE_ENV === 'production';
  const adminPassword = envValue(env, 'SEED_ADMIN_PASSWORD');
  const totp = envValue(env, 'SEED_ADMIN_TOTP_SECRET')?.replace(/\s+/g, '').toUpperCase();
  const validatorKey = envValue(env, 'SEED_VALIDATOR_KEY');
  const validatorPin = envValue(env, 'SEED_VALIDATOR_PIN');
  const problems: string[] = [];

  if (validatorPin !== undefined && !NEW_PIN_PATTERN.test(validatorPin)) {
    problems.push('SEED_VALIDATOR_PIN must be 6 to 12 digits');
  }
  if (totp !== undefined && !TOTP_SECRET_PATTERN.test(totp)) {
    problems.push('SEED_ADMIN_TOTP_SECRET must be a base32 secret (A-Z, 2-7), 16 to 64 characters');
  }
  if (production) {
    if (adminPassword === undefined) {
      problems.push('SEED_ADMIN_PASSWORD is required in production');
    } else if (adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH || isDeniedSecret(adminPassword)) {
      problems.push(
        `SEED_ADMIN_PASSWORD must have at least ${MIN_ADMIN_PASSWORD_LENGTH} characters and must not be a default from the repository`,
      );
    }
    if (validatorKey === undefined) {
      problems.push('SEED_VALIDATOR_KEY is required in production');
    } else if (validatorKey.length < MIN_PRODUCTION_SECRET_LENGTH || isDeniedSecret(validatorKey)) {
      problems.push(
        `SEED_VALIDATOR_KEY must be a random value of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters, not a default from the repository`,
      );
    }
    if (validatorPin === undefined) {
      problems.push('SEED_VALIDATOR_PIN is required in production');
    } else if (validatorPin === DEFAULT_VALIDATOR_PIN) {
      problems.push('SEED_VALIDATOR_PIN must not be the development default');
    }
    if (totp !== undefined) {
      problems.push(
        'SEED_ADMIN_TOTP_SECRET is for development demo stands only; in production the owner enrols TOTP at the first login',
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`[seed] refusing to run:\n  - ${problems.join('\n  - ')}`);
  }

  if (adminPassword === undefined) {
    console.warn(
      `[seed] WARNING: SEED_ADMIN_PASSWORD is not set; a newly created ${ADMIN_EMAIL} gets the default development password "${DEFAULT_ADMIN_PASSWORD}". Set the variable before seeding any shared environment.`,
    );
  }
  if (validatorKey === undefined || validatorPin === undefined) {
    console.warn(
      '[seed] WARNING: SEED_VALIDATOR_KEY / SEED_VALIDATOR_PIN not set; a newly created demo validator device uses development defaults.',
    );
  }
  return {
    adminPassword: adminPassword ?? DEFAULT_ADMIN_PASSWORD,
    adminTotpSecret: totp ?? null,
    validatorKey: validatorKey ?? DEFAULT_VALIDATOR_KEY,
    validatorPin: validatorPin ?? DEFAULT_VALIDATOR_PIN,
  };
}

/**
 * Owner account. Created once with a scrypt hash of the current back-office parameters
 * (PASSWORD_SCRYPT_PARAMS, ln=17, 64-byte key). An existing row is never changed: its password,
 * role and active flag belong to the back office. The only exception is a development
 * SEED_ADMIN_TOTP_SECRET, written when the admin has no TOTP yet.
 */
async function seedAdmin(credentials: SeedCredentials): Promise<{ id: string; totp: boolean }> {
  const existing = await prisma.adminUser.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing !== null) {
    if (credentials.adminTotpSecret !== null && existing.totpSecret === null) {
      await prisma.adminUser.update({
        where: { id: existing.id },
        data: { totpSecret: credentials.adminTotpSecret, totpLastStep: null },
      });
      console.log(
        `[seed] admin user ${ADMIN_EMAIL} kept as is; TOTP secret set from SEED_ADMIN_TOTP_SECRET`,
      );
      return { id: existing.id, totp: true };
    }
    console.log(
      `[seed] admin user ${ADMIN_EMAIL} exists, kept as is (password, role, active, TOTP)`,
    );
    return { id: existing.id, totp: existing.totpSecret !== null };
  }
  const admin = await prisma.adminUser.create({
    data: {
      id: uuidv7(),
      email: ADMIN_EMAIL,
      passwordHash: await hashPassword(credentials.adminPassword, PASSWORD_SCRYPT_PARAMS),
      totpSecret: credentials.adminTotpSecret,
      role: 'owner',
      name: 'Адміністратор Порт City',
      active: true,
    },
  });
  console.log(`[seed] admin user ${ADMIN_EMAIL} created`);
  return { id: admin.id, totp: admin.totpSecret !== null };
}

async function seedFeatureFlags(): Promise<void> {
  for (const flag of FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: { key: flag.key, enabled: flag.enabled, payload: flag.payload },
      update: { payload: flag.payload },
    });
  }
  console.log(`[seed] feature flags: ${FEATURE_FLAGS.length}`);
}

async function seedRuleSet(adminId: string): Promise<void> {
  await prisma.loyaltyRuleSet.upsert({
    where: { version: 1 },
    create: {
      id: uuidv7(),
      version: 1,
      activeFrom: new Date(SEED_EPOCH_MS),
      config: RULE_SET_V1,
      note: 'Defaults from the development plan, section 12.2',
      createdById: adminId,
    },
    update: { config: RULE_SET_V1 },
  });
  console.log('[seed] loyalty rule set v1');
}

async function seedTariff(adminId: string): Promise<void> {
  await prisma.parkingTariff.upsert({
    where: { version: 1 },
    create: {
      id: uuidv7(),
      version: 1,
      activeFrom: new Date(SEED_EPOCH_MS),
      config: TARIFF_V1,
      createdById: adminId,
    },
    update: { config: TARIFF_V1 },
  });
  console.log('[seed] parking tariff v1');
}

async function seedTenants(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const t of TENANTS) {
    if (t.hours !== null) {
      const parsed = parseTenantHours(t.hours);
      if (!parsed.ok) {
        throw new Error(`[seed] invalid hours of tenant ${t.slug}: ${parsed.problem}`);
      }
    }
    const data = {
      name: t.name,
      category: t.category,
      floor: t.floor,
      website: t.website ?? null,
      participates: t.participates ?? true,
      excludedFromProgram: t.excludedFromProgram ?? false,
      ratePercentOverride: t.ratePercentOverride ?? null,
      status: 'active' as const,
      hours: t.hours === null ? Prisma.DbNull : (t.hours as Prisma.InputJsonObject),
      locationText: t.locationText,
      mapImageUrl: t.mapImageUrl,
    };
    const tenant = await prisma.tenant.upsert({
      where: { slug: t.slug },
      create: { id: uuidv7(), slug: t.slug, ...data },
      update: data,
    });
    ids.set(t.slug, tenant.id);
  }
  console.log(`[seed] tenants: ${ids.size}`);
  return ids;
}

async function seedMallInfo(): Promise<void> {
  await prisma.mallInfo.upsert({
    where: { id: 1 },
    create: { id: 1, ...MALL_INFO },
    update: MALL_INFO,
  });
  console.log('[seed] mall info');
}

async function seedFiscalNumbers(
  tenants: Map<string, string>,
  adminId: string,
  now: Date,
): Promise<void> {
  let count = 0;
  for (const t of TENANTS) {
    const tenantId = requireId(tenants, t.slug);
    for (const fn of t.fns) {
      await prisma.tenantFiscalNumber.upsert({
        where: { fn },
        create: {
          id: uuidv7(),
          fn,
          tenantId,
          status: 'active',
          source: 'admin',
          confirmedById: adminId,
          confirmedAt: now,
          note: 'seed',
        },
        update: { tenantId, status: 'active' },
      });
      count += 1;
    }
  }
  console.log(`[seed] fiscal numbers: ${count}`);
}

async function seedRewards(tenants: Map<string, string>): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const r of REWARDS) {
    const id = seedId(`reward:${r.key}`);
    const data = {
      title: r.title,
      description: r.description,
      costPoints: r.costPoints,
      kind: r.kind,
      tenantId: r.tenantSlug === null ? null : requireId(tenants, r.tenantSlug),
      perUserLimit: r.perUserLimit,
      active: true,
      sortOrder: r.sortOrder,
      terms: 'Винагорода активується в застосунку і дійсна 2 хвилини після активації.',
    };
    await prisma.reward.upsert({ where: { id }, create: { id, ...data }, update: data });
    ids.set(r.key, id);
  }
  console.log(`[seed] rewards: ${ids.size}`);
  return ids;
}

async function seedPromos(tenants: Map<string, string>, now: Date): Promise<void> {
  const { year } = kyivWallClock(now);
  let intertopEnd = kyiv(year, 11, 15, 23, 59);
  if (intertopEnd.getTime() < now.getTime()) {
    intertopEnd = kyiv(year + 1, 11, 15, 23, 59);
  }

  const intertopTemplateId = seedId('coupon-template:intertop-20');
  const intertopTemplate = {
    discountText: '-20 % на весь асортимент',
    perUserLimit: 1,
    totalLimit: 500,
    requiresActivation: true,
    validityHoursAfterClaim: 72,
    terms: 'Не сумується з іншими знижками. Один купон на покупку.',
  };
  await prisma.couponTemplate.upsert({
    where: { id: intertopTemplateId },
    create: { id: intertopTemplateId, ...intertopTemplate },
    update: intertopTemplate,
  });
  const intertopPromo = {
    tenantId: requireId(tenants, 'intertop'),
    title: '-20 % INTERTOP до 15.11',
    body: 'Отримайте купон на знижку 20 % на весь асортимент INTERTOP у Порт City. Активуйте купон на касі.',
    kind: 'coupon' as const,
    category: 'fashion' as const,
    validFrom: addMs(now, -7 * DAY),
    validTo: intertopEnd,
    status: 'published' as const,
    couponTemplateId: intertopTemplateId,
    priority: 100,
  };
  const intertopPromoId = seedId('promo:intertop-20');
  await prisma.promo.upsert({
    where: { id: intertopPromoId },
    create: { id: intertopPromoId, ...intertopPromo },
    update: intertopPromo,
  });

  const aromaTemplateId = seedId('coupon-template:aroma-1plus1');
  const aromaTemplate = {
    discountText: '1+1 на каву',
    perUserLimit: 2,
    totalLimit: null,
    requiresActivation: true,
    validityHoursAfterClaim: 24,
    terms: 'Друга кава такого самого або меншого розміру безкоштовно.',
  };
  await prisma.couponTemplate.upsert({
    where: { id: aromaTemplateId },
    create: { id: aromaTemplateId, ...aromaTemplate },
    update: aromaTemplate,
  });
  const aromaPromo = {
    tenantId: requireId(tenants, 'aroma-kava'),
    title: '1+1 Aroma Kava',
    body: 'Дві кави за ціною однієї в Aroma Kava на першому поверсі. Купон діє 24 години після отримання.',
    kind: 'coupon' as const,
    category: 'food' as const,
    validFrom: addMs(now, -3 * DAY),
    validTo: addMs(now, 30 * DAY),
    status: 'published' as const,
    couponTemplateId: aromaTemplateId,
    priority: 90,
  };
  const aromaPromoId = seedId('promo:aroma-1plus1');
  await prisma.promo.upsert({
    where: { id: aromaPromoId },
    create: { id: aromaPromoId, ...aromaPromo },
    update: aromaPromo,
  });
  console.log('[seed] promos: 2');
}

async function seedEvents(tenants: Map<string, string>, now: Date): Promise<void> {
  const today = kyivWallClock(now);
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const daysToSaturday = (6 - weekday + 7) % 7 || 7;
  const startsAt = kyiv(today.year, today.month, today.day + daysToSaturday, 15, 0);
  const workshop = {
    title: 'Майстер-клас для дітей',
    description:
      'Творчий майстер-клас для дітей 4-10 років. Субота, 15:00. Кількість місць обмежена.',
    startsAt,
    endsAt: addMs(startsAt, 90 * MINUTE),
    venue: 'Figli Migli, 3 поверх',
    category: 'masterclass' as const,
    tenantId: requireId(tenants, 'figli-migli'),
    capacity: 30,
    registrationOpen: true,
    admission: 'registration' as const,
    externalUrl: null,
    // Prototype: «До 4 учасників на одну реєстрацію».
    maxPersonsPerRegistration: 4,
    ageMin: 4,
    ageMax: 10,
    // Kept for older clients; equals ageMin.
    ageLimit: 4,
    status: 'published' as const,
  };
  const workshopId = seedId('event:kids-workshop');
  await prisma.event.upsert({
    where: { id: workshopId },
    create: { id: workshopId, ...workshop },
    update: workshop,
  });

  // External admission (tickets on the cinema's site): no registration in the app.
  const daysToSunday = (7 - weekday) % 7 || 7;
  const cinemaStartsAt = kyiv(today.year, today.month, today.day + daysToSunday, 18, 0);
  const cinema = {
    title: 'Кінопоказ «Осінь у місті»',
    description: 'Сеанси й квитки - на сайті Premier City.',
    startsAt: cinemaStartsAt,
    endsAt: addMs(cinemaStartsAt, 2 * HOUR),
    venue: 'Premier City, 3 поверх',
    category: 'cinema' as const,
    tenantId: requireId(tenants, 'premier-city'),
    capacity: null,
    registrationOpen: false,
    admission: 'external' as const,
    externalUrl: 'https://premiercity.com.ua/',
    maxPersonsPerRegistration: null,
    ageMin: null,
    ageMax: null,
    ageLimit: null,
    status: 'published' as const,
  };
  const cinemaId = seedId('event:cinema-autumn');
  await prisma.event.upsert({
    where: { id: cinemaId },
    create: { id: cinemaId, ...cinema },
    update: cinema,
  });
  console.log('[seed] events: 2');
}

interface DemoMember {
  userId: string;
  deviceId: string;
  accountId: string;
  vehicleId: string;
}

async function seedDemoMember(now: Date): Promise<DemoMember> {
  // Every profile field the seed fills counts as already announced: otherwise the first
  // PATCH /me would publish user.profile_field_completed for each of them and club would pay
  // per-field bonuses for fields the member never filled in the app.
  const completedProfileFields = [...PROFILE_FIELDS];
  const user = await prisma.user.upsert({
    where: { phone: DEMO_PHONE },
    create: {
      id: uuidv7(),
      phone: DEMO_PHONE,
      email: 'oleh.demo@portcity.local',
      firstName: 'Олег',
      lastName: 'Демо',
      birthDate: new Date(Date.UTC(1990, 4, 14)),
      gender: 'male',
      city: 'Луцьк',
      status: 'active',
      memberCode: DEMO_MEMBER_CODE,
      profileCompletedAt: addMs(now, -40 * DAY),
      completedProfileFields,
    },
    update: {
      firstName: 'Олег',
      gender: 'male',
      city: 'Луцьк',
      status: 'active',
      memberCode: DEMO_MEMBER_CODE,
      deletedAt: null,
      completedProfileFields,
    },
  });

  const childId = seedId('child:demo');
  const child = { userId: user.id, birthMonth: 5, birthYear: 2019, gender: 'female' as const };
  await prisma.child.upsert({
    where: { id: childId },
    create: { id: childId, ...child },
    update: child,
  });

  const deviceId = seedId('device:demo');
  await prisma.device.upsert({
    where: { id: deviceId },
    create: {
      id: deviceId,
      userId: user.id,
      platform: 'ios',
      model: 'iPhone 15',
      appVersion: '1.0.0',
      fingerprint: 'seed-demo-device',
      pushEnabled: false,
      lastSeenAt: now,
    },
    update: { userId: user.id, lastSeenAt: now },
  });

  for (const purpose of ['program', 'marketing'] as const) {
    const id = seedId(`consent:demo:${purpose}`);
    await prisma.consent.upsert({
      where: { id },
      create: {
        id,
        userId: user.id,
        purpose,
        version: '2026-10',
        grantedAt: addMs(now, -40 * DAY),
      },
      update: { revokedAt: null },
    });
  }

  const vehicleId = seedId('vehicle:demo');
  await prisma.vehicle.upsert({
    where: { id: vehicleId },
    create: {
      id: vehicleId,
      userId: user.id,
      plate: DEMO_PLATE,
      plateDisplay: 'AC 1234 BC',
      label: 'Моє авто',
      verified: true,
      verifiedVia: 'talon',
      verifiedAt: addMs(now, -30 * DAY),
      isDefault: true,
    },
    update: {
      label: 'Моє авто',
      verified: true,
      verifiedVia: 'talon',
      isDefault: true,
      deletedAt: null,
    },
  });

  const balances = {
    availableBalance: 320,
    pendingBalance: 0,
    lifetimeEarned: 380,
    newcomerLockUntil: null,
    welcomeState: { register: true, profile: true, firstReceipt: true },
  };
  const account = await prisma.loyaltyAccount.upsert({
    where: { userId: user.id },
    create: { id: seedId('account:demo'), userId: user.id, ...balances },
    update: balances,
  });

  console.log(`[seed] demo member ${DEMO_PHONE} (member code ${DEMO_MEMBER_CODE})`);
  return { userId: user.id, deviceId, accountId: account.id, vehicleId };
}

/**
 * Demo till device. The PIN (scrypt, DEFAULT_SCRYPT_PARAMS as the rewards module writes it),
 * device key and active flag are written only when the device is created: re-running the seed
 * never resets a changed PIN or reactivates a revoked device.
 */
async function seedValidatorDevice(
  tenants: Map<string, string>,
  credentials: SeedCredentials,
): Promise<string> {
  const id = seedId('validator:aroma-kava-1');
  const placement = {
    tenantId: requireId(tenants, 'aroma-kava'),
    name: 'Aroma Kava, каса 1',
  };
  const existing = await prisma.validatorDevice.findUnique({ where: { id } });
  if (existing === null) {
    await prisma.validatorDevice.create({
      data: {
        id,
        ...placement,
        pinHash: await hashPassword(credentials.validatorPin, DEFAULT_SCRYPT_PARAMS),
        deviceKeyHash: sha256Hex(credentials.validatorKey),
        active: true,
        revokedAt: null,
      },
    });
    console.log('[seed] validator devices: 1 created');
  } else {
    await prisma.validatorDevice.update({ where: { id }, data: placement });
    console.log('[seed] validator devices: 1 kept (PIN, key and active flag unchanged)');
  }
  return id;
}

interface ReceiptSeed {
  key: string;
  fn: string;
  fiscalId: string;
  tenantSlug: string | null;
  issuedAt: Date;
  submittedAt: Date;
  totalKopecks: number;
  source: 'qr' | 'manual';
  status: ReceiptStatus;
  riskFlags: string[];
  riskScore: number;
  /** Receipt.moderationReasons (codes of receipts/domain/rules.ts MODERATION_REASONS). */
  moderationReasons: string[];
  /** Receipt.rejectionCode: rule that rejected the receipt; null for moderator decisions. */
  rejectionCode: string | null;
  pointsAwarded: number | null;
  decision: { reason: string; at: Date } | null;
  photoKey: string | null;
  trail: Array<{
    from: ReceiptStatus | null;
    to: ReceiptStatus;
    byAdmin: boolean;
    note: string | null;
  }>;
}

async function upsertReceipt(
  seed: ReceiptSeed,
  demo: DemoMember,
  tenants: Map<string, string>,
  adminId: string,
): Promise<string> {
  const tenantId = seed.tenantSlug === null ? null : requireId(tenants, seed.tenantSlug);
  const data = {
    userId: demo.userId,
    deviceId: demo.deviceId,
    issuedAt: seed.issuedAt,
    totalKopecks: seed.totalKopecks,
    rawQr:
      seed.source === 'qr'
        ? taxQrUrl(seed.fn, seed.fiscalId, seed.issuedAt, seed.totalKopecks)
        : null,
    source: seed.source,
    photoKey: seed.photoKey,
    tenantId,
    status: seed.status,
    riskFlags: seed.riskFlags,
    riskScore: seed.riskScore,
    moderationReasons: seed.moderationReasons,
    rejectionCode: seed.rejectionCode,
    moderatorId: seed.decision === null ? null : adminId,
    decisionReason: seed.decision === null ? null : seed.decision.reason,
    decidedAt: seed.decision === null ? null : seed.decision.at,
    pointsAwarded: seed.pointsAwarded,
    submittedAt: seed.submittedAt,
    // The seed numbers are already canonical (digits, no leading zeros); the raw columns keep
    // what was "submitted". verification stays 'not_required' (no 24 h hold for demo receipts).
    fnRaw: seed.fn,
    fiscalIdRaw: seed.fiscalId,
  };
  const receipt = await prisma.receipt.upsert({
    where: { fn_fiscalId: { fn: seed.fn, fiscalId: seed.fiscalId } },
    create: { id: seedId(`receipt:${seed.key}`), fn: seed.fn, fiscalId: seed.fiscalId, ...data },
    update: data,
  });

  let step = 0;
  for (const event of seed.trail) {
    step += 1;
    const id = seedId(`receipt-event:${seed.key}:${step}`);
    const eventData = {
      receiptId: receipt.id,
      fromStatus: event.from,
      toStatus: event.to,
      actorType: event.byAdmin ? ('admin' as const) : ('system' as const),
      actorId: event.byAdmin ? adminId : null,
      note: event.note,
      createdAt: addMs(seed.submittedAt, step * 1000),
    };
    await prisma.receiptEvent.upsert({
      where: { id },
      create: { id, ...eventData },
      update: eventData,
    });
  }
  return receipt.id;
}

interface TxSeed {
  key: string;
  type: PointsTxType;
  state: PointsTxState;
  amount: number;
  sourceType: PointsSourceType;
  sourceId: string | null;
  createdAt: Date;
  reason: string | null;
  createdById: string | null;
  /** History display data (written once at insert; the ledger is append-only). */
  title: string;
  subtitle: string | null;
  counterparty: Prisma.InputJsonObject | null;
}

/** Demo ledger: 6 transactions summing to 320 available points, 3 receipts, one redeemed voucher, one adjustment. */
async function seedDemoActivity(
  demo: DemoMember,
  tenants: Map<string, string>,
  rewards: Map<string, string>,
  adminId: string,
  validatorId: string,
  now: Date,
): Promise<void> {
  // 40 days ago, on the hour, so the history reads naturally in the app.
  const d0 = new Date(Math.floor(addMs(now, -40 * DAY).getTime() / HOUR) * HOUR);

  const intertopFn = '4000100011';
  const premierFn = '4000100041';

  const receiptAId = await upsertReceipt(
    {
      key: 'demo-a',
      fn: intertopFn,
      fiscalId: '1180000001',
      tenantSlug: 'intertop',
      issuedAt: addMs(d0, 3 * DAY - 20 * MINUTE),
      submittedAt: addMs(d0, 3 * DAY),
      totalKopecks: 600000,
      source: 'qr',
      status: 'credited',
      riskFlags: [],
      riskScore: 0,
      moderationReasons: [],
      rejectionCode: null,
      pointsAwarded: 180,
      decision: null,
      photoKey: null,
      trail: [
        { from: null, to: 'uploaded', byAdmin: false, note: null },
        { from: 'uploaded', to: 'parsed', byAdmin: false, note: null },
        {
          from: 'parsed',
          to: 'auto_approved',
          byAdmin: false,
          note: 'fn whitelisted, total below the auto-approve threshold',
        },
        { from: 'auto_approved', to: 'credited', byAdmin: false, note: '180 points' },
      ],
    },
    demo,
    tenants,
    adminId,
  );

  await upsertReceipt(
    {
      key: 'demo-b',
      fn: premierFn,
      fiscalId: '1180000002',
      tenantSlug: 'premier-city',
      issuedAt: addMs(now, -2 * DAY - 45 * MINUTE),
      submittedAt: addMs(now, -2 * DAY),
      totalKopecks: 1250000,
      source: 'qr',
      status: 'needs_moderation',
      riskFlags: ['high_total'],
      riskScore: 40,
      moderationReasons: ['total_above_threshold'],
      rejectionCode: null,
      pointsAwarded: null,
      decision: null,
      photoKey: null,
      trail: [
        { from: null, to: 'uploaded', byAdmin: false, note: null },
        { from: 'uploaded', to: 'parsed', byAdmin: false, note: null },
        {
          from: 'parsed',
          to: 'needs_moderation',
          byAdmin: false,
          note: 'total above the auto-approve threshold',
        },
      ],
    },
    demo,
    tenants,
    adminId,
  );

  await upsertReceipt(
    {
      key: 'demo-c',
      fn: '4009999999',
      fiscalId: '1180000003',
      tenantSlug: null,
      issuedAt: addMs(now, -5 * DAY - 3 * HOUR),
      submittedAt: addMs(now, -5 * DAY),
      totalKopecks: 45000,
      source: 'manual',
      status: 'rejected',
      riskFlags: ['fn_unknown'],
      riskScore: 60,
      moderationReasons: ['manual_submission', 'fn_not_whitelisted'],
      // Rejected by a moderator, not by a rule.
      rejectionCode: null,
      pointsAwarded: null,
      decision: { reason: 'Чек видано не в ТРЦ Порт City', at: addMs(now, -4 * DAY) },
      photoKey: 'receipts/seed/demo-c.jpg',
      trail: [
        { from: null, to: 'uploaded', byAdmin: false, note: null },
        { from: 'uploaded', to: 'parsed', byAdmin: false, note: null },
        {
          from: 'parsed',
          to: 'needs_moderation',
          byAdmin: false,
          note: 'manual submission, unknown fn',
        },
        {
          from: 'needs_moderation',
          to: 'rejected',
          byAdmin: true,
          note: 'Чек видано не в ТРЦ Порт City',
        },
      ],
    },
    demo,
    tenants,
    adminId,
  );

  const adjustmentId = seedId('adjustment:demo-compensation');
  const redemptionId = seedId('redemption:demo-coffee');
  const voucherId = seedId('voucher:demo-coffee');
  const aromaId = requireId(tenants, 'aroma-kava');
  const intertopId = requireId(tenants, 'intertop');
  const coffeeRewardId = requireId(rewards, 'coffee-to-go');

  // Demo history from before the per-field profile bonuses: the single 30-point profile bonus
  // stays as it was credited (the ledger is append-only and the balances below add up to it).
  const txSeeds: readonly TxSeed[] = [
    {
      key: 'welcome-register',
      type: 'welcome',
      state: 'spent',
      amount: 50,
      sourceType: 'system',
      sourceId: null,
      createdAt: d0,
      reason: 'Вітальний бонус за реєстрацію',
      createdById: null,
      title: 'Вітальний бонус за реєстрацію',
      subtitle: null,
      counterparty: null,
    },
    {
      key: 'welcome-profile',
      type: 'welcome',
      state: 'available',
      amount: 30,
      sourceType: 'system',
      sourceId: null,
      createdAt: addMs(d0, 1 * HOUR),
      reason: 'Бонус за заповнений профіль',
      createdById: null,
      title: 'Бонус за заповнений профіль',
      subtitle: null,
      counterparty: null,
    },
    {
      key: 'earn-receipt-a',
      type: 'earn',
      state: 'available',
      amount: 180,
      sourceType: 'receipt',
      sourceId: receiptAId,
      createdAt: addMs(d0, 3 * DAY),
      reason: null,
      createdById: null,
      title: 'Нарахування за чек',
      subtitle: 'INTERTOP, 1 поверх',
      counterparty: {
        tenantId: intertopId,
        tenantName: 'INTERTOP',
        receiptId: receiptAId,
        receiptTotalKopecks: 600000,
      },
    },
    {
      key: 'welcome-first-receipt',
      type: 'welcome',
      state: 'available',
      amount: 20,
      sourceType: 'receipt',
      sourceId: receiptAId,
      createdAt: addMs(d0, 3 * DAY + 1000),
      reason: 'Бонус за перший чек',
      createdById: null,
      title: 'Бонус за перший чек',
      subtitle: null,
      counterparty: { receiptId: receiptAId },
    },
    {
      key: 'adjust-compensation',
      type: 'adjust',
      state: 'available',
      amount: 100,
      sourceType: 'manual',
      sourceId: adjustmentId,
      createdAt: addMs(d0, 10 * DAY),
      reason: 'Компенсація за технічний збій у застосунку',
      createdById: adminId,
      title: 'Нарахування від ТРЦ',
      subtitle: 'Компенсація за технічний збій',
      counterparty: null,
    },
    {
      key: 'spend-coffee',
      type: 'spend',
      state: 'spent',
      amount: -60,
      sourceType: 'redemption',
      sourceId: redemptionId,
      createdAt: addMs(d0, 12 * DAY),
      reason: 'Кава з собою (Aroma Kava)',
      createdById: null,
      title: 'Обмін на винагороду',
      subtitle: 'Кава з собою',
      counterparty: {
        tenantId: aromaId,
        tenantName: 'Aroma Kava',
        rewardId: coffeeRewardId,
        rewardTitle: 'Кава з собою',
        voucherId,
      },
    },
  ];

  const txIds = new Map<string, string>();
  for (const tx of txSeeds) {
    const positive = tx.amount > 0;
    const row = await prisma.pointsTransaction.upsert({
      where: { idempotencyKey: `seed:demo:${tx.key}` },
      create: {
        id: seedId(`tx:demo:${tx.key}`),
        accountId: demo.accountId,
        type: tx.type,
        state: tx.state,
        amount: tx.amount,
        sourceType: tx.sourceType,
        sourceId: tx.sourceId,
        idempotencyKey: `seed:demo:${tx.key}`,
        availableAt: positive ? tx.createdAt : null,
        // Month arithmetic in Kyiv wall-clock time, exactly as the ledger computes it.
        expiresAt: positive ? computeExpiresAt(tx.createdAt, RULE_SET_V1.pointsTtlMonths) : null,
        reason: tx.reason,
        createdById: tx.createdById,
        createdAt: tx.createdAt,
        title: tx.title,
        subtitle: tx.subtitle,
        counterparty: tx.counterparty ?? Prisma.DbNull,
      },
      // The ledger is append-only; an existing row is left untouched.
      update: {},
    });
    txIds.set(tx.key, row.id);
  }

  // FIFO expiry buckets: positive rows grouped by the Kyiv calendar day of expiresAt (the key the
  // ledger uses), spend consumed from the earliest bucket. The only debit (spend-coffee) records
  // which buckets it took (points_spend_allocations), so a refund restores the original expiry.
  const buckets = new Map<string, number>();
  let toConsume = 0;
  for (const tx of txSeeds) {
    if (tx.amount > 0) {
      const key = bucketDayKey(computeExpiresAt(tx.createdAt, RULE_SET_V1.pointsTtlMonths));
      buckets.set(key, (buckets.get(key) ?? 0) + tx.amount);
    } else {
      toConsume -= tx.amount;
    }
  }
  const allocations: Array<{ expiresOn: Date; amount: number }> = [];
  for (const key of [...buckets.keys()].sort()) {
    if (toConsume <= 0) {
      break;
    }
    const remaining = buckets.get(key) ?? 0;
    const taken = Math.min(remaining, toConsume);
    buckets.set(key, remaining - taken);
    toConsume -= taken;
    if (taken > 0) {
      allocations.push({ expiresOn: dayKeyToDate(key), amount: taken });
    }
  }
  // Append-only table: insert once, existing rows are skipped (never updated).
  await prisma.pointsSpendAllocation.createMany({
    data: allocations.map((allocation) => ({
      spendTxId: requireId(txIds, 'spend-coffee'),
      ...allocation,
    })),
    skipDuplicates: true,
  });
  for (const [key, remaining] of buckets) {
    const expiresOn = dayKeyToDate(key);
    await prisma.pointsExpiryBucket.upsert({
      where: { accountId_expiresOn: { accountId: demo.accountId, expiresOn } },
      create: { accountId: demo.accountId, expiresOn, remaining },
      update: { remaining },
    });
  }

  await prisma.receipt.update({
    where: { id: receiptAId },
    data: { pointsTxId: requireId(txIds, 'earn-receipt-a') },
  });

  const adjustment = {
    accountId: demo.accountId,
    userId: demo.userId,
    amount: 100,
    reason: 'Компенсація за технічний збій у застосунку',
    requestedById: adminId,
    approvedById: adminId,
    status: 'applied' as const,
    pointsTxId: requireId(txIds, 'adjust-compensation'),
    thresholdPoints: 500,
    decidedAt: addMs(d0, 10 * DAY),
    appliedAt: addMs(d0, 10 * DAY),
  };
  await prisma.manualAdjustment.upsert({
    where: { id: adjustmentId },
    create: { id: adjustmentId, ...adjustment },
    update: adjustment,
  });

  const activatedAt = addMs(d0, 12 * DAY + 2 * HOUR);
  const voucher = {
    userId: demo.userId,
    kind: 'reward' as const,
    title: 'Кава з собою',
    subtitle: 'Aroma Kava, 1 поверх',
    tenantId: aromaId,
    code: 'K7M2PQ',
    status: 'redeemed' as const,
    activatedAt,
    activationExpiresAt: addMs(activatedAt, 2 * MINUTE),
    redeemedAt: addMs(activatedAt, 1 * MINUTE),
    redeemedByDeviceId: validatorId,
    redeemedByTenantId: aromaId,
    expiresAt: addMs(d0, 12 * DAY + 30 * DAY),
    sourceType: 'redemption' as const,
    sourceId: redemptionId,
    meta: { rewardId: coffeeRewardId, costPoints: 60 },
    createdAt: addMs(d0, 12 * DAY),
  };
  await prisma.voucher.upsert({
    where: { id: voucherId },
    create: { id: voucherId, ...voucher },
    update: voucher,
  });

  const redemption = {
    userId: demo.userId,
    rewardId: coffeeRewardId,
    pointsTxId: requireId(txIds, 'spend-coffee'),
    voucherId,
    status: 'issued' as const,
    createdAt: addMs(d0, 12 * DAY),
  };
  await prisma.redemption.upsert({
    where: { id: redemptionId },
    create: { id: redemptionId, ...redemption },
    update: redemption,
  });

  const logId = seedId('voucher-redemption-log:demo-coffee');
  const log = {
    voucherId,
    validatorDeviceId: validatorId,
    method: 'code' as const,
    codeTried: 'K7M2PQ',
    outcome: 'redeemed' as const,
    message: null,
    createdAt: addMs(activatedAt, 1 * MINUTE),
  };
  await prisma.voucherRedemptionLog.upsert({
    where: { id: logId },
    create: { id: logId, ...log },
    update: log,
  });

  const notifications = [
    {
      key: 'receipt-a-credited',
      kind: 'receipt_credited',
      title: 'Чек зараховано',
      body: 'Нараховано 180 балів за покупку в INTERTOP на 6 000,00 грн.',
      data: { receiptId: receiptAId, points: 180 },
      createdAt: addMs(d0, 3 * DAY + 5000),
      readAt: addMs(d0, 4 * DAY),
    },
    {
      key: 'receipt-b-moderation',
      kind: 'receipt_needs_moderation',
      title: 'Чек на перевірці',
      body: 'Чек Premier City на 12 500,00 грн перевіряє модератор. Зазвичай це займає до 24 годин.',
      data: { receiptId: seedId('receipt:demo-b') },
      createdAt: addMs(now, -2 * DAY + 5000),
      readAt: null,
    },
  ];
  for (const n of notifications) {
    const id = seedId(`notification:demo:${n.key}`);
    const data = {
      userId: demo.userId,
      kind: n.kind,
      title: n.title,
      body: n.body,
      data: n.data,
      channel: 'inapp' as const,
      sentAt: n.createdAt,
      readAt: n.readAt,
      createdAt: n.createdAt,
    };
    await prisma.notification.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  console.log(
    '[seed] demo activity: 3 receipts, 6 transactions, 1 adjustment, 1 redeemed voucher, 2 notifications',
  );
}

interface SessionShape {
  status: ParkingSessionStatus;
  exitedAt: Date | null;
  paidUntil: Date | null;
  amountDueKopecks: number;
  amountPaidKopecks: number;
  lastSyncedAt: Date;
  closedReason: string | null;
}

/** Demo parking session reproducing the design canon for today (Kyiv; design/v2/CONVENTIONS.md):
 *  entered 14:00, free until 14:30, 60 UAH due at 15:20, paid at 15:20 until 16:00, exit at 15:52.
 *  The emulator reports the same session (providerRef emu-demo-session) on level -2, row C. */
async function seedParkingScenario(demo: DemoMember, scenario: Scenario, now: Date): Promise<void> {
  const today = kyivWallClock(now);
  const at = (hour: number, minute: number): Date =>
    kyiv(today.year, today.month, today.day, hour, minute);

  let shape: SessionShape;
  switch (scenario) {
    case 'free':
      shape = {
        status: 'open',
        exitedAt: null,
        paidUntil: null,
        amountDueKopecks: 0,
        amountPaidKopecks: 0,
        lastSyncedAt: at(14, 10),
        closedReason: null,
      };
      break;
    case 'payable':
      shape = {
        status: 'payable',
        exitedAt: null,
        paidUntil: null,
        amountDueKopecks: 6000,
        amountPaidKopecks: 0,
        lastSyncedAt: at(15, 20),
        closedReason: null,
      };
      break;
    case 'paid':
      shape = {
        status: 'paid',
        exitedAt: null,
        paidUntil: at(16, 0),
        amountDueKopecks: 0,
        amountPaidKopecks: 6000,
        lastSyncedAt: at(15, 25),
        closedReason: null,
      };
      break;
    case 'closed':
      shape = {
        status: 'closed',
        exitedAt: at(15, 52),
        paidUntil: at(16, 0),
        amountDueKopecks: 0,
        amountPaidKopecks: 6000,
        lastSyncedAt: at(15, 52),
        closedReason: 'exit',
      };
      break;
  }

  const sessionId = seedId('parking-session:demo');
  const session = {
    userId: demo.userId,
    vehicleId: demo.vehicleId,
    plate: DEMO_PLATE,
    zone: 'underground' as const,
    level: '-2',
    spot: 'C',
    enteredAt: at(14, 0),
    source: 'provider' as const,
    providerRef: 'emu-demo-session',
    ...shape,
  };
  await prisma.parkingSession.upsert({
    where: { id: sessionId },
    create: { id: sessionId, ...session },
    update: session,
  });

  if (scenario === 'paid' || scenario === 'closed') {
    // Same meta keys as ParkingPaymentsService.pay writes: the receipt screen (GET /payments/:id)
    // shows the plate and «виїзд до 16:00» and builds the signed operator QR from paidUntil.
    const meta = {
      sessionId,
      scenario,
      paidUntil: at(16, 0).toISOString(),
      plate: DEMO_PLATE,
      plateDisplay: 'AC 1234 BC',
      providerRef: 'emu-demo-session',
    };
    const payment = await prisma.payment.upsert({
      where: { idempotencyKey: 'seed:demo:parking-payment' },
      create: {
        id: seedId('payment:demo-parking'),
        userId: demo.userId,
        purpose: 'parking',
        amountKopecks: 6000,
        currency: 'UAH',
        provider: 'mock',
        providerRef: 'mock-demo-parking',
        status: 'succeeded',
        idempotencyKey: 'seed:demo:parking-payment',
        paidAt: at(15, 20),
        meta,
      },
      update: { status: 'succeeded', paidAt: at(15, 20), meta },
    });
    // Applied and registered with the operator at 15:20, so the 5-minute payments-sweep does not
    // treat the demo payment as unapplied.
    const outcome = {
      paidUntil: at(16, 0),
      outcome: 'applied',
      outcomeAt: at(15, 20),
      registeredAt: at(15, 20),
    };
    await prisma.parkingPaymentLink.upsert({
      where: { sessionId_paymentId: { sessionId, paymentId: payment.id } },
      create: { sessionId, paymentId: payment.id, ...outcome },
      update: outcome,
    });
  }
  console.log(`[seed] parking scenario "${scenario}" for ${DEMO_PLATE}`);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * Development only: support request numbers continue from № 1041, so the first request of a
 * fresh demo database is № 1042 as in the prototype. Skipped in production and once any request
 * exists or the sequence has been used.
 */
async function seedSupportRequestNumbers(production: boolean): Promise<void> {
  if (production || (await prisma.supportRequest.count()) > 0) {
    return;
  }
  const [state] = await prisma.$queryRaw<Array<{ is_called: boolean }>>`
    SELECT is_called FROM support_requests_number_seq`;
  if (state !== undefined && !state.is_called) {
    await prisma.$queryRaw`SELECT setval('support_requests_number_seq', 1041)`;
    console.log('[seed] support request numbers start at 1042');
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const production = process.env.NODE_ENV === 'production';
  // Validated before anything is written: in production the seed refuses default credentials.
  const credentials = readSeedCredentials(process.env);
  const scenario = readScenario();

  const admin = await seedAdmin(credentials);
  await seedFeatureFlags();
  await seedRuleSet(admin.id);
  await seedTariff(admin.id);
  const tenants = await seedTenants();
  await seedMallInfo();
  await seedFiscalNumbers(tenants, admin.id, now);
  const rewards = await seedRewards(tenants);
  await seedPromos(tenants, now);
  await seedEvents(tenants, now);
  const demo = await seedDemoMember(now);
  const validatorId = await seedValidatorDevice(tenants, credentials);
  await seedDemoActivity(demo, tenants, rewards, admin.id, validatorId, now);
  await seedParkingScenario(demo, scenario, now);
  await seedSupportRequestNumbers(production);

  if (!admin.totp) {
    // ADMIN_REQUIRE_TOTP_ROLES (default owner,manager): the owner cannot sign in with the
    // password alone. POST /admin/auth/login answers 403 PC_ADMIN_TOTP_SETUP_REQUIRED with
    // details.enrollmentToken -> POST /admin/auth/totp/enroll -> .../enroll/confirm.
    console.warn(
      `[seed] NOTE: ${ADMIN_EMAIL} has no TOTP yet. The owner must enrol an authenticator app at the first login (POST /admin/auth/login -> 403 PC_ADMIN_TOTP_SETUP_REQUIRED -> /admin/auth/totp/enroll -> /admin/auth/totp/enroll/confirm); see docs/RUNBOOK.md.`,
    );
  }
  console.log('[seed] done');
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
