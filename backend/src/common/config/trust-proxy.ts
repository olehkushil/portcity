import { isIP } from 'node:net';

/**
 * `TRUST_PROXY` as Express understands it (`app.set('trust proxy', value)`):
 * - `false`: the socket address is the client (no proxy);
 * - a number N: trust N reverse-proxy hops, the client is the N-th address from the right of
 *   `X-Forwarded-For` (one load balancer = 1);
 * - a list of addresses / CIDR ranges / the names `loopback`, `linklocal`, `uniquelocal`: trust
 *   only proxies inside those networks.
 *
 * Backward compatible with the former boolean: `true`/`yes`/`on` = 1 hop, `false`/`no`/`off`/`0`
 * = no proxy. Trusting every hop (Express `true`) is never configured: any client could then
 * forge `X-Forwarded-For` and pick its own rate-limit key.
 */
export type TrustProxySetting = false | number | string[];

export const MAX_TRUST_PROXY_HOPS = 10;
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const TRUE_WORDS = new Set(['true', 'yes', 'on', 'y']);
const FALSE_WORDS = new Set(['false', 'no', 'off', 'n']);

function isCidrOrAddress(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) {
    return true;
  }
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) {
    return false;
  }
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d{1,3}$/.test(prefix)) {
    return false;
  }
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

/** Parses the variable; throws an Error with a readable message for anything else. */
export function parseTrustProxy(raw: string): TrustProxySetting {
  const value = raw.trim().toLowerCase();
  if (value === '' || FALSE_WORDS.has(value)) {
    return false;
  }
  if (TRUE_WORDS.has(value)) {
    return 1;
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > MAX_TRUST_PROXY_HOPS) {
      throw new Error(`hop count must be between 0 and ${MAX_TRUST_PROXY_HOPS}`);
    }
    return hops === 0 ? false : hops;
  }
  const entries = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const invalid = entries.filter((entry) => !isCidrOrAddress(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `must be false, true (= 1 hop), a hop count or a comma-separated list of IP addresses, CIDR ranges or loopback/linklocal/uniquelocal (invalid: ${invalid.join(', ') || value})`,
    );
  }
  return entries;
}
