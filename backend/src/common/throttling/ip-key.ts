import { isIPv4, isIPv6 } from 'node:net';

/**
 * Rate-limit key of a client address. A subscriber usually gets a whole IPv6 /64 (often a /56 or
 * /48), so counting single IPv6 addresses lets one client rotate through billions of keys; the
 * key is therefore the /64 network: `2001:db8:1:2::/64`. IPv4 addresses (including IPv4-mapped
 * IPv6 such as `::ffff:203.0.113.7`) stay as they are. Anything unparseable is returned trimmed
 * and cut to 45 characters (the column width of otp_challenges.ip) so it still counts as a key.
 */
export function ipRateLimitKey(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') {
    return null;
  }
  let value = ip.trim();
  if (value === '') {
    return null;
  }
  // Zone index (fe80::1%eth0) and brackets ([2001:db8::1]) are not part of the address.
  value = value.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
  if (isIPv4(value)) {
    return value;
  }
  if (!isIPv6(value)) {
    return value.slice(0, 45);
  }
  const lower = value.toLowerCase();
  const hextets = expandIpv6(lower);
  if (!hextets) {
    return lower.slice(0, 45);
  }
  // IPv4-mapped (::ffff:a.b.c.d): Express reports IPv4 clients like this on dual-stack sockets.
  if (hextets.slice(0, 5).every((group) => /^0+$/.test(group)) && hextets[5] === 'ffff') {
    const high = parseInt(hextets[6] ?? '0', 16);
    const low = parseInt(hextets[7] ?? '0', 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${hextets
    .slice(0, 4)
    .map((part) => part.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Eight 16-bit groups of an IPv6 address (embedded IPv4 tails converted), or null. */
function expandIpv6(address: string): string[] | null {
  let text = address;
  const ipv4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (ipv4Tail?.[1]) {
    const octets = ipv4Tail[1].split('.').map(Number);
    if (octets.some((octet) => octet > 255)) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, text.length - ipv4Tail[1].length)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  return groups.length === 8 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
    ? groups
    : null;
}
