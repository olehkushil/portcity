import { createHmac } from 'node:crypto';
import { MEMBER_QR_PATTERN } from '../../../common/contracts/club';
import { buildMemberQrPayload, memberQrHmac, parseMemberQrPayload } from './member-qr';

const SECRET = 'test-only-member-qr-secret';

describe('member QR payload', () => {
  it('builds PC1:<memberCode>:<hmac8> with the first 8 hex chars of HMAC-SHA256(secret, code)', () => {
    const payload = buildMemberQrPayload(SECRET, '734211800');
    const expectedHmac = createHmac('sha256', SECRET).update('734211800').digest('hex').slice(0, 8);
    expect(payload).toBe(`PC1:734211800:${expectedHmac}`);
    expect(MEMBER_QR_PATTERN.test(payload)).toBe(true);
    expect(memberQrHmac(SECRET, '734211800')).toHaveLength(8);
  });

  it('is deterministic for the same secret and differs per secret', () => {
    expect(buildMemberQrPayload(SECRET, '123456789')).toBe(
      buildMemberQrPayload(SECRET, '123456789'),
    );
    expect(buildMemberQrPayload(SECRET, '123456789')).not.toBe(
      buildMemberQrPayload('other-secret', '123456789'),
    );
  });

  it.each(['12345678', '1234567890', 'ABCDEFGHI', ''])('rejects member code %p', (code) => {
    expect(() => buildMemberQrPayload(SECRET, code)).toThrow(RangeError);
  });

  it('parses and verifies a genuine payload (surrounding whitespace tolerated)', () => {
    const payload = buildMemberQrPayload(SECRET, '734211800');
    expect(parseMemberQrPayload(SECRET, `  ${payload}\n`)).toEqual({ memberCode: '734211800' });
  });

  it.each([
    ['wrong prefix', 'PC2:734211800:deadbeef'],
    ['tampered code', 'PC1:734211801:'],
    ['uppercase hmac', 'PC1:734211800:DEADBEEF'],
    ['short hmac', 'PC1:734211800:abc'],
    ['garbage', 'hello'],
  ])('rejects %s', (_name, raw) => {
    const payload = raw.endsWith(':') ? `${raw}${memberQrHmac(SECRET, '734211800')}` : raw;
    expect(parseMemberQrPayload(SECRET, payload)).toBeNull();
  });

  it('rejects a payload signed with another secret', () => {
    const payload = buildMemberQrPayload('other-secret', '734211800');
    expect(parseMemberQrPayload(SECRET, payload)).toBeNull();
  });
});
