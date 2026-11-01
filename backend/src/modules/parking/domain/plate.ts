import { PLATE_PATTERN } from '../../../common/contracts/parking';

/**
 * Cyrillic letters that look like Latin ones and are allowed on Ukrainian plates
 * (DSTU 4278: A B C E H I K M O P T X). Users type either alphabet; storage is Latin.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  А: 'A',
  В: 'B',
  С: 'C',
  Е: 'E',
  Н: 'H',
  І: 'I',
  К: 'K',
  М: 'M',
  О: 'O',
  Р: 'P',
  Т: 'T',
  Х: 'X',
};

/** Standard Ukrainian plate: two letters, four digits, two letters. */
const UA_STANDARD_PLATE = /^([A-Z]{2})(\d{4})([A-Z]{2})$/;

export interface NormalisedPlate {
  /** Latin letters and digits only, e.g. `AC1234BC`. */
  plate: string;
  /** Human form, e.g. `AC 1234 BC`. */
  plateDisplay: string;
}

/**
 * Normalises user input to the stored form: trims, drops separators, uppercases and maps
 * look-alike Cyrillic letters to Latin. Returns null when the result is not a plausible plate.
 */
export function normalisePlate(input: string): NormalisedPlate | null {
  const upper = input.trim().toUpperCase();
  let plate = '';
  for (const char of upper) {
    if (char === ' ' || char === '-' || char === '.' || char === ' ' || char === '_') {
      continue;
    }
    plate += CYRILLIC_TO_LATIN[char] ?? char;
  }
  if (!PLATE_PATTERN.test(plate) || !/\d/.test(plate) || !/[A-Z]/.test(plate)) {
    return null;
  }
  return { plate, plateDisplay: formatPlate(plate) };
}

/** `AC1234BC` -> `AC 1234 BC`; other formats are returned unchanged. */
export function formatPlate(plate: string): string {
  const match = UA_STANDARD_PLATE.exec(plate);
  if (!match) {
    return plate;
  }
  return `${match[1]} ${match[2]} ${match[3]}`;
}

/** Longest run of digits in a normalised plate (`AC1234BC` -> `1234`), or null. */
export function plateDigits(plate: string): string | null {
  const runs = plate.match(/\d+/g);
  if (!runs || runs.length === 0) {
    return null;
  }
  return runs.reduce((longest, run) => (run.length > longest.length ? run : longest), '');
}
