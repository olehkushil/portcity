import { ipRateLimitKey } from './ip-key';

describe('ipRateLimitKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:198.51.100.1', '198.51.100.1'],
    ['0:0:0:0:0:ffff:cb00:7107', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['[2001:db8:a:b::7]', '2001:db8:a:b::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['2001:db8:1:2::ffff:10.0.0.1', '2001:db8:1:2::/64'],
  ])('maps %s to %s', (input, expected) => {
    expect(ipRateLimitKey(input)).toBe(expected);
  });

  it('puts every address of one /64 under the same key and different /64s under different keys', () => {
    const a = ipRateLimitKey('2001:db8:1:2::a');
    const b = ipRateLimitKey('2001:db8:1:2:ffff::b');
    const other = ipRateLimitKey('2001:db8:1:3::a');
    expect(a).toBe(b);
    expect(other).not.toBe(a);
  });

  it('keeps unparseable values as a bounded key and maps empty input to null', () => {
    expect(ipRateLimitKey('not-an-ip')).toBe('not-an-ip');
    expect(ipRateLimitKey('x'.repeat(80))).toHaveLength(45);
    expect(ipRateLimitKey('')).toBeNull();
    expect(ipRateLimitKey('  ')).toBeNull();
    expect(ipRateLimitKey(undefined)).toBeNull();
    expect(ipRateLimitKey(null)).toBeNull();
  });
});
