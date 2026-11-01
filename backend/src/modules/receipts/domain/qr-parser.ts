/**
 * Parser of the tax-service receipt QR (brief section 7).
 *
 * Accepted input: the URL printed in the QR of a fiscal receipt,
 * `https://cabinet.tax.gov.ua/cashregs/check?fn=...&id=...&date=YYYYMMDD&time=HHMMSS&sm=123.45&mac=...`
 * (http or https, with or without `www`, any parameter order, URL-encoded or not, surrounding
 * whitespace). Unknown parameters are ignored.
 *
 * Pure module: no Nest, no Prisma. `parseTaxQr` never throws; `parseTaxQrOrThrow` throws only
 * `QrParseError`.
 */
import { TAX_QR_HOST, TAX_QR_PATH } from '../../../common/contracts/receipts';
import { uahToKopecks } from '../../../common/money/money';
import { kyivLocalToUtc } from '../../../common/time/kyiv';
import { canonicalFiscalId, canonicalFn } from './fiscal-ids';

export const QR_PARSE_ERROR_CODES = [
  'NOT_A_TAX_URL',
  'MISSING_PARAM',
  'BAD_DATE',
  'BAD_SUM',
] as const;
export type QrParseErrorCode = (typeof QR_PARSE_ERROR_CODES)[number];

export const QR_PARAMS = ['fn', 'id', 'date', 'time', 'sm', 'mac'] as const;
export type QrParam = (typeof QR_PARAMS)[number];

/** Longest QR text we try to parse; real tax URLs are about 120 characters. */
export const MAX_QR_TEXT_LENGTH = 4096;
/**
 * Fiscal number of the receipt (`id`) as it may appear before canonicalisation: letters,
 * digits, spaces and dashes. The stored value is `canonicalFiscalId()` of it.
 */
export const FISCAL_ID_PATTERN = /^[A-Za-z0-9\s-]{1,128}$/;
/** Receipts above 1 000 000 UAH are treated as a scanning error. */
export const MAX_TOTAL_KOPECKS = 100_000_000;
const MIN_YEAR = 2015;
const MAX_YEAR = 2100;
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
const TIME_PATTERN = /^(\d{2})(\d{2})(\d{2})?$/;

export interface ParsedTaxQr {
  /** Canonical fiscal number of the cash register (6-20 digits, no leading zeros). */
  fn: string;
  /** Canonical fiscal number of the receipt (see canonicalFiscalId). */
  fiscalId: string;
  /** `fn` parameter exactly as found in the QR (trimmed). */
  fnRaw: string;
  /** `id` parameter exactly as found in the QR (trimmed). */
  fiscalIdRaw: string;
  /** Kyiv wall-clock date and time of the receipt converted to a UTC instant. */
  issuedAt: Date;
  totalKopecks: number;
  /** Offline receipts carry a MAC; kept for moderators. */
  mac?: string;
  /** The trimmed input text. */
  raw: string;
}

export class QrParseError extends Error {
  readonly code: QrParseErrorCode;
  readonly param: QrParam | null;

  constructor(code: QrParseErrorCode, message: string, param: QrParam | null = null) {
    super(message);
    this.name = 'QrParseError';
    this.code = code;
    this.param = param;
  }
}

export type QrParseResult = { ok: true; value: ParsedTaxQr } | { ok: false; error: QrParseError };

/** Parses the QR text; never throws. */
export function parseTaxQr(input: string): QrParseResult {
  try {
    return { ok: true, value: parseStrict(input) };
  } catch (error) {
    if (error instanceof QrParseError) {
      return { ok: false, error };
    }
    return {
      ok: false,
      error: new QrParseError('NOT_A_TAX_URL', 'QR text could not be parsed as a tax-service URL'),
    };
  }
}

/** Parses the QR text; throws `QrParseError` and nothing else. */
export function parseTaxQrOrThrow(input: string): ParsedTaxQr {
  const result = parseTaxQr(input);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function isQrParseError(error: unknown): error is QrParseError {
  return error instanceof QrParseError;
}

function notTaxUrl(message: string): QrParseError {
  return new QrParseError('NOT_A_TAX_URL', message);
}

function parseStrict(input: string): ParsedTaxQr {
  if (typeof input !== 'string') {
    throw notTaxUrl('QR text must be a string');
  }
  const raw = input.trim();
  if (raw.length === 0) {
    throw notTaxUrl('QR text is empty');
  }
  if (raw.length > MAX_QR_TEXT_LENGTH) {
    throw notTaxUrl(`QR text is longer than ${MAX_QR_TEXT_LENGTH} characters`);
  }

  const url = toTaxUrl(raw);
  const params = collectParams(url);

  const fnRaw = requireParam(params, 'fn');
  const fn = canonicalFn(fnRaw);
  if (fn === null) {
    throw new QrParseError('MISSING_PARAM', 'Parameter "fn" must be 6-20 digits', 'fn');
  }
  const fiscalIdRaw = requireParam(params, 'id');
  const fiscalId = FISCAL_ID_PATTERN.test(fiscalIdRaw) ? canonicalFiscalId(fiscalIdRaw) : null;
  if (fiscalId === null) {
    throw new QrParseError(
      'MISSING_PARAM',
      'Parameter "id" must be 1-64 letters, digits or dashes',
      'id',
    );
  }
  const issuedAt = parseDateTime(requireParam(params, 'date'), requireParam(params, 'time'));
  const totalKopecks = parseSum(requireParam(params, 'sm'));

  const result: ParsedTaxQr = { fn, fiscalId, fnRaw, fiscalIdRaw, issuedAt, totalKopecks, raw };
  const mac = params.get('mac')?.trim();
  if (mac) {
    result.mac = mac;
  }
  return result;
}

function toTaxUrl(raw: string): URL {
  let text = raw.replace(/&amp;/gi, '&');
  // Some scanners deliver the whole URL percent-encoded.
  if (/^https?%3a%2f%2f/i.test(text)) {
    text = safeDecode(text);
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (hasScheme && !/^https?:\/\//i.test(text)) {
    throw notTaxUrl('Only http(s) URLs of the tax service are accepted');
  }
  const candidate = hasScheme ? text : `https://${text}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw notTaxUrl('QR text is not a URL');
  }
  // `?` encoded as %3F puts the whole query into the path; decode once and re-parse.
  if (url.search === '' && /%3f/i.test(url.pathname)) {
    try {
      url = new URL(safeDecode(url.href));
    } catch {
      throw notTaxUrl('QR text is not a URL');
    }
  }

  const host = url.hostname.toLowerCase();
  if (host !== TAX_QR_HOST && host !== `www.${TAX_QR_HOST}`) {
    throw notTaxUrl(`Host "${url.hostname}" is not the tax service`);
  }
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (path !== TAX_QR_PATH) {
    throw notTaxUrl(`Path "${url.pathname}" is not the receipt check page`);
  }
  return url;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw notTaxUrl('QR text contains malformed URL encoding');
  }
}

/** First occurrence wins; parameter names are matched case-insensitively. */
function collectParams(url: URL): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    const name = key.trim().toLowerCase();
    if (!params.has(name)) {
      params.set(name, value);
    }
  }
  return params;
}

function requireParam(params: Map<string, string>, name: QrParam): string {
  const value = params.get(name)?.trim();
  if (value === undefined || value === '') {
    throw new QrParseError('MISSING_PARAM', `Parameter "${name}" is missing`, name);
  }
  return value;
}

function digits(group: string | undefined): number {
  return group === undefined ? Number.NaN : Number(group);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseDateTime(date: string, time: string): Date {
  const dateMatch = DATE_PATTERN.exec(date.replace(/[-.]/g, ''));
  if (!dateMatch) {
    throw new QrParseError('BAD_DATE', 'Parameter "date" must be YYYYMMDD', 'date');
  }
  const year = digits(dateMatch[1]);
  const month = digits(dateMatch[2]);
  const day = digits(dateMatch[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new QrParseError('BAD_DATE', `Parameter "date" is not a calendar date: ${date}`, 'date');
  }

  const timeMatch = TIME_PATTERN.exec(time.replace(/:/g, ''));
  if (!timeMatch) {
    throw new QrParseError('BAD_DATE', 'Parameter "time" must be HHMMSS or HHMM', 'time');
  }
  const hour = digits(timeMatch[1]);
  const minute = digits(timeMatch[2]);
  const second = timeMatch[3] === undefined ? 0 : digits(timeMatch[3]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new QrParseError('BAD_DATE', `Parameter "time" is not a time of day: ${time}`, 'time');
  }

  return kyivLocalToUtc({ year, month, day, hour, minute, second });
}

function parseSum(sm: string): number {
  let kopecks: number;
  try {
    kopecks = uahToKopecks(sm);
  } catch {
    throw new QrParseError('BAD_SUM', `Parameter "sm" is not an amount: ${sm}`, 'sm');
  }
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) {
    throw new QrParseError('BAD_SUM', 'Parameter "sm" must be a positive amount', 'sm');
  }
  if (kopecks > MAX_TOTAL_KOPECKS) {
    throw new QrParseError('BAD_SUM', 'Parameter "sm" is implausibly large', 'sm');
  }
  return kopecks;
}
