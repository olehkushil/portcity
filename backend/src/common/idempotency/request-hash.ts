import { createHash } from 'node:crypto';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** 8-128 chars: letters, digits, `_ - . :`. UUIDs are the recommended format. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` properties dropped,
 * Dates as ISO strings. Arrays keep their order (order is meaningful).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? 'null';
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        result[key] = normalize(item);
      }
    }
    return result;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null;
  }
  return value;
}

export interface RequestHashInput {
  method: string;
  /** Route path without query string, e.g. `/api/v1/receipts/qr`. */
  path: string;
  body?: unknown;
}

/** SHA-256 over method, path and canonical body; stored next to the idempotency key. */
export function computeRequestHash(input: RequestHashInput): string {
  const material = `${input.method.toUpperCase()}\n${input.path}\n${canonicalJson(input.body ?? null)}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
