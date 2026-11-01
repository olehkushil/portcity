/**
 * Content contract: tenants, the fiscal-number whitelist and per-tenant loyalty rules.
 * Implemented by `src/modules/content`, provided under CONTENT_PORT.
 * Consumers: receipts (fn lookup, exclusion, effective rate), rewards and promos (tenant names),
 * admin (reports).
 */
import type { Tx, Uuid } from './shared';

export const CONTENT_PORT = Symbol('CONTENT_PORT');

export const TENANT_STATUSES = ['active', 'hidden', 'closed'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const FISCAL_NUMBER_STATUSES = ['active', 'pending', 'blocked'] as const;
export type FiscalNumberStatus = (typeof FISCAL_NUMBER_STATUSES)[number];

export const FISCAL_NUMBER_SOURCES = ['admin', 'receipt', 'import'] as const;
export type FiscalNumberSource = (typeof FISCAL_NUMBER_SOURCES)[number];

/** Category registry (Tenant.category is a plain string column); extend here, not in the schema. */
export const TENANT_CATEGORIES = [
  'fashion',
  'coffee',
  'cinema',
  'bowling',
  'entertainment',
  'kids',
  'hypermarket',
  'sport',
  'electronics',
  'beauty',
  'pharmacy',
  'home',
  'food_court',
  'services',
  'other',
] as const;
export type TenantCategory = (typeof TENANT_CATEGORIES)[number];

/** Fiscal number of a cash register as printed in the tax-service QR (`fn`): 6-20 digits. */
export const FISCAL_NUMBER_PATTERN = /^\d{6,20}$/;

/** Longest raw `fn` (digits plus separators) accepted before canonicalisation. */
export const FISCAL_NUMBER_RAW_MAX_LENGTH = 64;

/** Whitespace, ASCII hyphen-minus and the Unicode dashes people paste from documents. */
const FISCAL_SEPARATORS = /[\s­‐-―−-]+/g;

/**
 * Canonical form of a cash register fiscal number (`fn`), shared by receipts (QR parser,
 * manual form, the `(fn, fiscal_id)` unique key) and content (whitelist): separators removed,
 * digits only, leading zeros stripped, then 6-20 digits. Returns null when the input is not a
 * fiscal number. Pure; never throws.
 *
 * `canonicalFiscalNumber(' 0004000-100-011 ')` -> `'4000100011'`.
 */
export function canonicalFiscalNumber(input: string): string | null {
  if (typeof input !== 'string' || input.length > FISCAL_NUMBER_RAW_MAX_LENGTH * 2) {
    return null;
  }
  const compact = input.replace(FISCAL_SEPARATORS, '');
  if (compact.length === 0 || compact.length > FISCAL_NUMBER_RAW_MAX_LENGTH) {
    return null;
  }
  if (!/^\d+$/.test(compact)) {
    return null;
  }
  const stripped = compact.replace(/^0+/, '');
  return FISCAL_NUMBER_PATTERN.test(stripped) ? stripped : null;
}

export interface TenantSummary {
  id: Uuid;
  slug: string;
  name: string;
  category: string;
  floor: number | null;
  logoKey: string | null;
  participates: boolean;
  /** Overrides `baseRatePercent` of the active rule set when set. */
  ratePercentOverride: number | null;
  /** Receipts from this tenant are rejected with PC_RECEIPT_EXCLUDED_TENANT. */
  excludedFromProgram: boolean;
  status: TenantStatus;
}

/**
 * TenantSummary plus what a card or a voucher shows about the shop (rewards, promos): public
 * logo URL, where it is in the mall, the map image and whether it is open now (Kyiv time; the
 * mall hours apply when the tenant has none).
 */
export interface TenantDisplaySummary extends TenantSummary {
  logoUrl: string | null;
  locationText: string | null;
  mapImageUrl: string | null;
  isOpenNow: boolean;
}

export interface FiscalNumberLookup {
  fn: string;
  status: FiscalNumberStatus;
  source: FiscalNumberSource;
  tenantId: Uuid | null;
  /** Populated when the number is mapped to a tenant. */
  tenant: TenantSummary | null;
  firstSeenAt: Date;
}

/** Loyalty parameters that apply to a tenant at a given moment (TenantLoyaltyRule or override). */
export interface EffectiveTenantRule {
  tenantId: Uuid;
  /** Null means "use baseRatePercent of the active rule set". */
  ratePercent: number | null;
  minTotalKopecks: number;
  dailyCapPoints: number | null;
  source: 'rule' | 'override' | 'none';
}

export interface ContentPort {
  getTenant(tenantId: Uuid): Promise<TenantSummary | null>;
  /** Display data of one tenant (any status; check `status` before showing it publicly). */
  getTenantSummaryById(tenantId: Uuid): Promise<TenantDisplaySummary | null>;
  /** Batch lookup; missing ids are omitted. */
  getTenants(tenantIds: readonly Uuid[]): Promise<TenantSummary[]>;
  /** Null when the fiscal number has never been seen. */
  findTenantByFiscalNumber(fn: string): Promise<FiscalNumberLookup | null>;
  /** True when the tenant is excluded from the program or does not exist. */
  isExcluded(tenantId: Uuid): Promise<boolean>;
  /** Effective rule at `at`: an active TenantLoyaltyRule wins over `ratePercentOverride`. */
  getTenantRule(tenantId: Uuid, at: Date): Promise<EffectiveTenantRule>;
  /**
   * Records a fiscal number seen on a receipt (status `pending`, source `receipt`) so admins can
   * map it to a tenant; returns the existing row when the number is already known.
   * `options.receiptId` is echoed in the `tenant.fiscal_number_seen` event so moderators see the
   * receipt the new cash register came from.
   */
  recordSeenFiscalNumber(
    fn: string,
    tx?: Tx,
    options?: RecordSeenFiscalNumberOptions,
  ): Promise<FiscalNumberLookup>;
}

export interface RecordSeenFiscalNumberOptions {
  receiptId?: Uuid | null;
}

export const CONTENT_ERROR_CODES = [
  'PC_TENANT_NOT_FOUND',
  'PC_TENANT_SLUG_TAKEN',
  'PC_FISCAL_NUMBER_INVALID',
  'PC_FISCAL_NUMBER_TAKEN',
  'PC_FISCAL_NUMBER_NOT_FOUND',
  'PC_TENANT_RULE_NOT_FOUND',
  'PC_TENANT_RULE_OVERLAP',
  /** 409: active <-> hidden, active|hidden -> closed, closed -> active are the only moves. */
  'PC_TENANT_INVALID_TRANSITION',
  /** 409: e.g. active -> pending or deleting an active number. */
  'PC_FISCAL_NUMBER_INVALID_TRANSITION',
  /** 422: an active number must be mapped to a tenant. */
  'PC_FISCAL_NUMBER_TENANT_REQUIRED',
  /** 422: validTo <= validFrom or an invalid date. */
  'PC_TENANT_RULE_INVALID_PERIOD',
  'PC_CONTENT_IMPORT_NOT_FOUND',
  /** 422: the import request holds no usable record. */
  'PC_CONTENT_IMPORT_EMPTY',
] as const;
export type ContentErrorCode = (typeof CONTENT_ERROR_CODES)[number];
