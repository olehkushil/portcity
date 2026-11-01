import { formatPlate, normalisePlate, plateDigits } from './plate';

describe('normalisePlate', () => {
  const valid: Array<[string, string, string]> = [
    ['AC1234BC', 'AC1234BC', 'AC 1234 BC'],
    ['ac 1234 bc', 'AC1234BC', 'AC 1234 BC'],
    ['  AC-1234-BC ', 'AC1234BC', 'AC 1234 BC'],
    ['АС1234ВС', 'AC1234BC', 'AC 1234 BC'],
    ['ас 1234 вс', 'AC1234BC', 'AC 1234 BC'],
    ['КА7777ІХ', 'KA7777IX', 'KA 7777 IX'],
    ['BC 123 AB', 'BC123AB', 'BC123AB'],
    ['12345AB', '12345AB', '12345AB'],
    ['AA1', 'AA1', 'AA1'],
  ];

  it.each(valid)('normalises %p to %p', (input, plate, display) => {
    expect(normalisePlate(input)).toEqual({ plate, plateDisplay: display });
  });

  const invalid: Array<[string, string]> = [
    ['empty', ''],
    ['spaces only', '   '],
    ['too short', 'A1'],
    ['too long', 'ABCDEFGHIJKLM1'],
    ['letters only', 'ABCDEF'],
    ['digits only', '123456'],
    ['non plate letters', 'AБ1234ГД'],
    ['punctuation', 'AC1234BC!'],
    ['latin lowercase with umlaut', 'ÄC1234BC'],
  ];

  it.each(invalid)('rejects %s', (_label, input) => {
    expect(normalisePlate(input)).toBeNull();
  });
});

describe('formatPlate', () => {
  it('spaces the standard Ukrainian format', () => {
    expect(formatPlate('AC1234BC')).toBe('AC 1234 BC');
  });

  it('leaves other formats unchanged', () => {
    expect(formatPlate('BC123AB')).toBe('BC123AB');
    expect(formatPlate('12345AB')).toBe('12345AB');
  });
});

describe('plateDigits', () => {
  it.each([
    ['AC1234BC', '1234'],
    ['BC123AB', '123'],
    ['A1B2345C', '2345'],
    ['ABCDEF', null],
  ])('%p -> %p', (plate, digits) => {
    expect(plateDigits(plate)).toBe(digits);
  });
});
