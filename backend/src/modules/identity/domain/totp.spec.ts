import {
  buildTotpUri,
  generateTotpCode,
  generateTotpSecret,
  matchTotpStep,
  totpStepAt,
  verifyTotpCode,
} from './totp';

describe('TOTP helpers', () => {
  const nowMs = Date.UTC(2026, 0, 15, 10, 0, 0);

  it('generates base32 secrets of 20 bytes', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('accepts the current code and codes within the tolerance window', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret, nowMs);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code, nowMs)).toBe(true);
    expect(verifyTotpCode(secret, ` ${code} `, nowMs)).toBe(true);
    expect(verifyTotpCode(secret, code, nowMs + 30_000)).toBe(true);
    expect(verifyTotpCode(secret, code, nowMs - 30_000)).toBe(true);
  });

  it('rejects codes outside the window, wrong codes and malformed input', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret, nowMs);
    expect(verifyTotpCode(secret, code, nowMs + 120_000)).toBe(false);
    expect(verifyTotpCode(secret, code, nowMs + 120_000, 0)).toBe(false);
    const other = generateTotpCode(generateTotpSecret(), nowMs);
    if (other !== code) {
      expect(verifyTotpCode(secret, other, nowMs)).toBe(false);
    }
    expect(verifyTotpCode(secret, '12345', nowMs)).toBe(false);
    expect(verifyTotpCode(secret, 'abcdef', nowMs)).toBe(false);
    expect(verifyTotpCode('not base32!', '123456', nowMs)).toBe(false);
  });

  it('finds the time step of a code within the tolerance window', () => {
    const secret = generateTotpSecret();
    const step = totpStepAt(nowMs);
    expect(step).toBe(Math.floor(nowMs / 30_000));
    const current = generateTotpCode(secret, nowMs);
    const previous = generateTotpCode(secret, nowMs - 30_000);
    const next = generateTotpCode(secret, nowMs + 30_000);

    expect(matchTotpStep(secret, current, nowMs)).toBe(step);
    expect(matchTotpStep(secret, ` ${current} `, nowMs + 29_000)).toBe(step);
    if (previous !== current && previous !== next) {
      expect(matchTotpStep(secret, previous, nowMs)).toBe(step - 1);
      expect(matchTotpStep(secret, previous, nowMs, 0)).toBeNull();
    }
    if (next !== current && next !== previous) {
      expect(matchTotpStep(secret, next, nowMs)).toBe(step + 1);
    }
    expect(matchTotpStep(secret, current, nowMs + 120_000)).toBeNull();
    expect(matchTotpStep(secret, 'abcdef', nowMs)).toBeNull();
    expect(matchTotpStep('not base32!', '123456', nowMs)).toBeNull();
  });

  it('builds an otpauth URI with issuer and label', () => {
    const uri = buildTotpUri(
      'PortCity Admin',
      'admin@portcity.local',
      'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    );
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=PortCity%20Admin');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(uri).toContain('admin%40portcity.local');
  });
});
