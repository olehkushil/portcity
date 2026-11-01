import {
  MAX_QR_TEXT_LENGTH,
  type ParsedTaxQr,
  QrParseError,
  type QrParseErrorCode,
  isQrParseError,
  parseTaxQr,
  parseTaxQrOrThrow,
} from './qr-parser';

const BASE = 'https://cabinet.tax.gov.ua/cashregs/check';

function ok(text: string): ParsedTaxQr {
  const result = parseTaxQr(text);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function fail(text: string): QrParseError {
  const result = parseTaxQr(text);
  if (result.ok) {
    throw new Error(`expected failure, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

describe('parseTaxQr', () => {
  describe('accepted inputs', () => {
    const cases: Array<{
      name: string;
      text: string;
      expected: Partial<Omit<ParsedTaxQr, 'issuedAt'>> & { issuedAt?: string };
    }> = [
      {
        name: 'canonical https URL with mac (winter, UTC+2)',
        text: `${BASE}?fn=4000100011&id=1180000001&date=20260115&time=143000&sm=1234.56&mac=A1B2`,
        expected: {
          fn: '4000100011',
          fiscalId: '1180000001',
          issuedAt: '2026-01-15T12:30:00.000Z',
          totalKopecks: 123456,
          mac: 'A1B2',
        },
      },
      {
        name: 'http, www, shuffled parameters, comma decimal, HHMM time (summer, UTC+3)',
        text: 'http://www.cabinet.tax.gov.ua/cashregs/check?sm=99,99&time=0905&date=20260715&id=77&fn=1234567890',
        expected: {
          fn: '1234567890',
          fiscalId: '77',
          issuedAt: '2026-07-15T06:05:00.000Z',
          totalKopecks: 9999,
        },
      },
      {
        name: 'comma decimal with a single fraction digit',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=1200&sm=1,5`,
        expected: { totalKopecks: 150 },
      },
      {
        name: 'URL-encoded parameter values (comma, colons in time)',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=12%3A30%3A00&sm=1%2C234.50`,
        expected: { totalKopecks: 123450, issuedAt: '2026-01-15T10:30:00.000Z' },
      },
      {
        name: 'whole URL percent-encoded by the scanner',
        text: 'https%3A%2F%2Fcabinet.tax.gov.ua%2Fcashregs%2Fcheck%3Ffn%3D4000100011%26id%3D9%26date%3D20260115%26time%3D120000%26sm%3D10.00',
        expected: { fn: '4000100011', fiscalId: '9', totalKopecks: 1000 },
      },
      {
        name: 'surrounding whitespace and newlines',
        text: `\n  ${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00  \r\n`,
        expected: { totalKopecks: 1000 },
      },
      {
        name: 'thousands separator as a space',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=1 234,50`,
        expected: { totalKopecks: 123450 },
      },
      {
        name: 'thousands separator as a comma with dot decimal',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=12,345.67`,
        expected: { totalKopecks: 1234567 },
      },
      {
        name: 'unknown parameters are ignored',
        text: `${BASE}?utm=1&fn=4000100011&foo=bar&id=5&date=20260115&time=120000&sm=10.00&x=y`,
        expected: { fn: '4000100011', fiscalId: '5' },
      },
      {
        name: 'scheme-less text',
        text: 'cabinet.tax.gov.ua/cashregs/check?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00',
        expected: { totalKopecks: 1000 },
      },
      {
        name: '1-kopeck rounding: 4.35 is 435, not 434',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=4.35`,
        expected: { totalKopecks: 435 },
      },
      {
        name: '1-kopeck rounding: 0.29 is 29 and three decimals round half up',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=0.29`,
        expected: { totalKopecks: 29 },
      },
      {
        name: 'three fraction digits round half up to one kopeck',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=12.345`,
        expected: { totalKopecks: 1235 },
      },
      {
        name: 'uppercase host and path',
        text: 'HTTPS://CABINET.TAX.GOV.UA/CashRegs/Check?FN=4000100011&ID=5&DATE=20260115&TIME=120000&SM=10.00',
        expected: { fn: '4000100011', fiscalId: '5', totalKopecks: 1000 },
      },
      {
        name: 'HTML-escaped ampersands',
        text: `${BASE}?fn=4000100011&amp;id=5&amp;date=20260115&amp;time=120000&amp;sm=10.00`,
        expected: { fiscalId: '5', totalKopecks: 1000 },
      },
      {
        name: 'question mark encoded as %3F',
        text: `${BASE}%3Ffn%3D4000100011%26id%3D5%26date%3D20260115%26time%3D120000%26sm%3D10.00`,
        expected: { fiscalId: '5', totalKopecks: 1000 },
      },
      {
        name: 'date with dashes and trailing slash in the path',
        text: `${BASE}/?fn=4000100011&id=5&date=2026-01-15&time=120000&sm=10.00`,
        expected: { issuedAt: '2026-01-15T10:00:00.000Z' },
      },
      {
        name: 'duplicate parameters: the first occurrence wins',
        text: `${BASE}?fn=4000100011&id=5&id=6&date=20260115&time=120000&sm=10.00&sm=20.00`,
        expected: { fiscalId: '5', totalKopecks: 1000 },
      },
      {
        name: 'alphanumeric fiscal id is canonicalised, the raw value is kept',
        text: `${BASE}?fn=4000100011&id=ab12-34&date=20260115&time=120000&sm=10.00`,
        expected: { fiscalId: 'AB1234', fiscalIdRaw: 'ab12-34', fnRaw: '4000100011' },
      },
      {
        name: 'leading zeros of a numeric id and of fn are stripped',
        text: `${BASE}?fn=004000100011&id=001180000001&date=20260115&time=120000&sm=10.00`,
        expected: {
          fn: '4000100011',
          fiscalId: '1180000001',
          fnRaw: '004000100011',
          fiscalIdRaw: '001180000001',
        },
      },
      {
        name: 'dashes and encoded spaces in the id are dropped',
        text: `${BASE}?fn=4000100011&id=118-000%200001&date=20260115&time=120000&sm=10.00`,
        expected: { fiscalId: '1180000001' },
      },
      {
        name: 'midnight on the DST switch day is converted with the new offset',
        text: `${BASE}?fn=4000100011&id=5&date=20260329&time=0430&sm=10.00`,
        expected: { issuedAt: '2026-03-29T01:30:00.000Z' },
      },
    ];

    it.each(cases)('$name', ({ text, expected }) => {
      const value = ok(text);
      const { issuedAt, ...rest } = expected;
      expect(value).toMatchObject(rest);
      if (issuedAt !== undefined) {
        expect(value.issuedAt.toISOString()).toBe(issuedAt);
      }
      expect(value.raw).toBe(text.trim());
    });

    it('maps every rewritten form of one receipt to the same (fn, fiscalId)', () => {
      // Reviewer's variants: the same receipt submitted again with a rewritten number.
      const variants = [
        'id=1180000001',
        'id=01180000001',
        'id=001180000001',
        'id=118-000-0001',
        'id=%201180000001%20',
        'id=1180000001&fn=0004000100011',
      ];
      const keys = new Set(
        variants.map((part) => {
          const text = part.includes('fn=')
            ? `${BASE}?${part}&date=20260115&time=120000&sm=10.00`
            : `${BASE}?fn=4000100011&${part}&date=20260115&time=120000&sm=10.00`;
          const value = ok(text);
          return `${value.fn}/${value.fiscalId}`;
        }),
      );
      expect([...keys]).toEqual(['4000100011/1180000001']);

      const letters = new Set(
        ['id=AB-12', 'id=ab12', 'id=Ab 12', 'id=a-b-1-2'].map(
          (part) => ok(`${BASE}?fn=4000100011&${part}&date=20260115&time=120000&sm=10.00`).fiscalId,
        ),
      );
      expect([...letters]).toEqual(['AB12']);
    });

    it('omits mac when the parameter is empty', () => {
      const value = ok(`${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00&mac=`);
      expect('mac' in value).toBe(false);
    });
  });

  describe('rejected inputs', () => {
    const cases: Array<{
      name: string;
      text: string;
      code: QrParseErrorCode;
      param?: string | null;
    }> = [
      { name: 'garbage text', text: 'hello world', code: 'NOT_A_TAX_URL' },
      { name: 'empty string', text: '   ', code: 'NOT_A_TAX_URL' },
      {
        name: 'another host',
        text: 'https://example.com/cashregs/check?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00',
        code: 'NOT_A_TAX_URL',
      },
      {
        name: 'look-alike host',
        text: 'https://cabinet.tax.gov.ua.evil.com/cashregs/check?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00',
        code: 'NOT_A_TAX_URL',
      },
      {
        name: 'another path on the tax host',
        text: 'https://cabinet.tax.gov.ua/login?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00',
        code: 'NOT_A_TAX_URL',
      },
      {
        name: 'non-http scheme',
        text: 'ftp://cabinet.tax.gov.ua/cashregs/check?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00',
        code: 'NOT_A_TAX_URL',
      },
      {
        name: 'a club card payload instead of a receipt',
        text: 'PC1:734211800:0a1b2c3d',
        code: 'NOT_A_TAX_URL',
      },
      {
        name: 'missing fn',
        text: `${BASE}?id=5&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'fn',
      },
      {
        name: 'fn with letters',
        text: `${BASE}?fn=40001000AB&id=5&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'fn',
      },
      {
        name: 'fn shorter than 6 digits',
        text: `${BASE}?fn=12345&id=5&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'fn',
      },
      {
        name: 'fn that is too short once the leading zeros are stripped',
        text: `${BASE}?fn=0000012345&id=5&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'fn',
      },
      {
        name: 'id with Cyrillic look-alike letters',
        text: `${BASE}?fn=4000100011&id=%D0%90B12&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'id',
      },
      {
        name: 'id made of dashes only',
        text: `${BASE}?fn=4000100011&id=---&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'id',
      },
      {
        name: 'missing id',
        text: `${BASE}?fn=4000100011&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'id',
      },
      {
        name: 'empty id',
        text: `${BASE}?fn=4000100011&id=&date=20260115&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'id',
      },
      {
        name: 'missing date',
        text: `${BASE}?fn=4000100011&id=5&time=120000&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'date',
      },
      {
        name: 'missing time',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&sm=10.00`,
        code: 'MISSING_PARAM',
        param: 'time',
      },
      {
        name: 'missing sum',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000`,
        code: 'MISSING_PARAM',
        param: 'sm',
      },
      {
        name: 'month 13',
        text: `${BASE}?fn=4000100011&id=5&date=20261345&time=120000&sm=10.00`,
        code: 'BAD_DATE',
        param: 'date',
      },
      {
        name: '30 February',
        text: `${BASE}?fn=4000100011&id=5&date=20260230&time=120000&sm=10.00`,
        code: 'BAD_DATE',
        param: 'date',
      },
      {
        name: 'date in DDMMYYYY order',
        text: `${BASE}?fn=4000100011&id=5&date=15012026&time=120000&sm=10.00`,
        code: 'BAD_DATE',
        param: 'date',
      },
      {
        name: 'hour 25',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=250000&sm=10.00`,
        code: 'BAD_DATE',
        param: 'time',
      },
      {
        name: 'time with three digits',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=930&sm=10.00`,
        code: 'BAD_DATE',
        param: 'time',
      },
      {
        name: 'zero sum',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=0.00`,
        code: 'BAD_SUM',
        param: 'sm',
      },
      {
        name: 'negative sum',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=-12.00`,
        code: 'BAD_SUM',
        param: 'sm',
      },
      {
        name: 'sum with letters',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=abc`,
        code: 'BAD_SUM',
        param: 'sm',
      },
      {
        name: 'sum in scientific notation',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=1e3`,
        code: 'BAD_SUM',
        param: 'sm',
      },
      {
        name: 'implausibly large sum',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=1000000.01`,
        code: 'BAD_SUM',
        param: 'sm',
      },
      {
        name: 'text longer than the limit',
        text: `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00&pad=${'x'.repeat(MAX_QR_TEXT_LENGTH)}`,
        code: 'NOT_A_TAX_URL',
      },
    ];

    it.each(cases)('$name -> $code', ({ text, code, param }) => {
      const error = fail(text);
      expect(error).toBeInstanceOf(QrParseError);
      expect(error.code).toBe(code);
      if (param !== undefined) {
        expect(error.param).toBe(param);
      }
    });

    it('never throws on mutated and random input', () => {
      const valid = `${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00`;
      let seed = 20260115;
      const random = (max: number): number => {
        seed = (seed * 48_271) % 2_147_483_647;
        return seed % max;
      };
      const alphabet = 'abc%&=?/:.,;#0123456789 \u0000ÿЧек';
      for (let round = 0; round < 500; round += 1) {
        const chars = [...valid];
        const edits = 1 + random(6);
        for (let edit = 0; edit < edits; edit += 1) {
          const at = random(chars.length);
          const action = random(3);
          const char = alphabet.charAt(random(alphabet.length));
          if (action === 0) {
            chars.splice(at, 1);
          } else if (action === 1) {
            chars.splice(at, 0, char);
          } else {
            chars[at] = char;
          }
        }
        const result = parseTaxQr(chars.join(''));
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(QrParseError);
        } else {
          expect(result.value.totalKopecks).toBeGreaterThan(0);
        }
      }
    });

    it('never throws, even for non-string input', () => {
      // Typed escape hatch: the parser must survive a caller that bypassed validation.
      const result = parseTaxQr(null as unknown as string);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NOT_A_TAX_URL');
      }
    });
  });

  describe('parseTaxQrOrThrow', () => {
    it('returns the value for a valid QR', () => {
      expect(
        parseTaxQrOrThrow(`${BASE}?fn=4000100011&id=5&date=20260115&time=120000&sm=10.00`)
          .totalKopecks,
      ).toBe(1000);
    });

    it('throws only QrParseError', () => {
      try {
        parseTaxQrOrThrow('not a url');
        throw new Error('expected a throw');
      } catch (error) {
        expect(isQrParseError(error)).toBe(true);
        expect((error as QrParseError).name).toBe('QrParseError');
      }
    });
  });
});
