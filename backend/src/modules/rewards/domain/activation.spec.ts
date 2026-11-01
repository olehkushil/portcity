import {
  VOUCHER_ACTIVATION_SECONDS,
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_PATTERN,
} from '../../../common/contracts/rewards';
import {
  ACTIVATION_TOKEN_KIND,
  activationTokenHash,
  computeActivationWindow,
  generateActivationCode,
  normalizeActivationCode,
  parseActivationToken,
  signActivationToken,
} from './activation';
import { signExpiringToken, toUnixSeconds } from './signed-token';

const SECRET = 'voucher-pepper-for-tests';
const NOW = new Date('2026-11-01T10:00:00.250Z');
const VOUCHER_ID = '01927f3a-8c4b-7d2e-9f10-123456789abc';

describe('computeActivationWindow', () => {
  it('lasts 120 seconds by default, aligned to whole seconds', () => {
    const window = computeActivationWindow(NOW);
    expect(VOUCHER_ACTIVATION_SECONDS).toBe(120);
    expect(window.activatedAt).toEqual(NOW);
    expect(window.exp).toBe(toUnixSeconds(NOW) + 120);
    expect(window.activationExpiresAt).toEqual(new Date('2026-11-01T10:02:00.000Z'));
  });

  it.each([
    [1, '2026-11-01T10:00:01.000Z'],
    [60, '2026-11-01T10:01:00.000Z'],
    [600, '2026-11-01T10:10:00.000Z'],
  ])('custom window of %i s ends at %s', (seconds, end) => {
    expect(computeActivationWindow(NOW, seconds).activationExpiresAt.toISOString()).toBe(end);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a window of %p seconds', (seconds) => {
    expect(() => computeActivationWindow(NOW, seconds)).toThrow();
  });
});

describe('generateActivationCode', () => {
  it('draws 6 characters from the unambiguous alphabet', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateActivationCode();
      expect(code).toMatch(VOUCHER_CODE_PATTERN);
      expect(code).toHaveLength(6);
      expect([...code].every((char) => VOUCHER_CODE_ALPHABET.includes(char))).toBe(true);
    }
  });

  it('never contains ambiguous characters 0, O, 1, I', () => {
    expect(VOUCHER_CODE_ALPHABET).not.toMatch(/[01OI]/);
  });

  it('passes length and alphabet to the generator', () => {
    const generator = jest.fn(() => 'K7M2PQ');
    expect(generateActivationCode(generator)).toBe('K7M2PQ');
    expect(generator).toHaveBeenCalledWith(6, VOUCHER_CODE_ALPHABET);
  });

  it.each(['K7M2P', 'K7M2PQX', 'K7M2P0', 'k7m2pq', 'K7M2PI'])(
    'rejects a generator result %p outside the pattern',
    (bad) => {
      expect(() => generateActivationCode(() => bad)).toThrow();
    },
  );
});

describe('normalizeActivationCode', () => {
  it.each([
    ['K7M2PQ', 'K7M2PQ'],
    ['k7m2pq', 'K7M2PQ'],
    ['  K7M2PQ  ', 'K7M2PQ'],
    ['K7M-2PQ', 'K7M2PQ'],
    ['K7 M2 PQ', 'K7M2PQ'],
    ['k7m-2pq', 'K7M2PQ'],
    ['K7M2P', null],
    ['K7M2PQQ', null],
    ['K7M2P0', null],
    ['K7M2PO', null],
    ['K7M2P1', null],
    ['K7M2PI', null],
    ['', null],
    ['K7M2P!', null],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeActivationCode(input)).toBe(expected);
  });

  it('returns null for non-string input', () => {
    expect(normalizeActivationCode(42 as unknown as string)).toBeNull();
  });
});

describe('activation tokens', () => {
  const exp = toUnixSeconds(NOW) + 120;

  it('round-trips the voucher id', () => {
    const token = signActivationToken(VOUCHER_ID, exp, SECRET);
    expect(parseActivationToken(token, SECRET, NOW)).toEqual({
      ok: true,
      subject: VOUCHER_ID,
      exp,
      expiresAt: new Date(exp * 1000),
    });
  });

  it.each([
    ['after the window', 121_000, { ok: false, reason: 'expired' }],
    ['at the last second', 119_000, { ok: true }],
  ])('parsed %s', (_name, offsetMs, expected) => {
    const token = signActivationToken(VOUCHER_ID, exp, SECRET);
    const parsed = parseActivationToken(token, SECRET, new Date(NOW.getTime() + offsetMs));
    expect(parsed).toMatchObject(expected);
  });

  it('rejects a token signed with another pepper', () => {
    const token = signActivationToken(VOUCHER_ID, exp, 'another-pepper');
    expect(parseActivationToken(token, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a shift token presented as an activation token (kind separation)', () => {
    const token = signExpiringToken({
      kind: 'validator-shift',
      subject: VOUCHER_ID,
      exp,
      secret: SECRET,
    });
    expect(parseActivationToken(token, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('hashes tokens deterministically per pepper', () => {
    const token = signActivationToken(VOUCHER_ID, exp, SECRET);
    const hash = activationTokenHash(token, SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(activationTokenHash(token, SECRET)).toBe(hash);
    expect(activationTokenHash(token, 'other')).not.toBe(hash);
    expect(activationTokenHash(signActivationToken(VOUCHER_ID, exp + 1, SECRET), SECRET)).not.toBe(
      hash,
    );
  });

  it('uses a dedicated token kind', () => {
    expect(ACTIVATION_TOKEN_KIND).toBe('voucher-activation');
  });
});
