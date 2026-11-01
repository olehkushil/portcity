/**
 * Tenant slugs: lowercase Latin letters, digits and single hyphens, at most 100 characters
 * (column `tenants.slug VARCHAR(100)`). `slugify` transliterates Ukrainian (KMU 2010 rules,
 * simplified) and Russian letters so "Фіглі Міглі" becomes "fihli-mihli" and
 * "Coffee & Gelato" becomes "coffee-gelato", matching the seed.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 100;

const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'iu',
  я: 'ia',
  // Russian letters that appear in brand names
  ы: 'y',
  э: 'e',
  ё: 'e',
  ъ: '',
};

/** Word-initial forms of the iotated letters (KMU 2010). */
const CYRILLIC_WORD_START: Readonly<Record<string, string>> = {
  є: 'ye',
  ї: 'yi',
  й: 'y',
  ю: 'yu',
  я: 'ya',
};

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function transliterate(text: string): string {
  let result = '';
  let previousIsLetter = false;
  for (const char of text.toLowerCase()) {
    if (char === "'" || char === 'ʼ' || char === '’') {
      // apostrophe inside a word (e.g. "м'ясо") is dropped without breaking the word
      continue;
    }
    const wordStart = !previousIsLetter ? CYRILLIC_WORD_START[char] : undefined;
    const mapped = wordStart ?? CYRILLIC[char];
    if (mapped !== undefined) {
      result += mapped;
      previousIsLetter = true;
      continue;
    }
    result += char;
    previousIsLetter = LETTER_OR_DIGIT.test(char);
  }
  return result;
}

/** Builds a slug from a display name; returns '' when nothing usable remains. */
export function slugify(name: string, maxLength: number = SLUG_MAX_LENGTH): string {
  const ascii = transliterate(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= maxLength) {
    return ascii;
  }
  return ascii.slice(0, maxLength).replace(/-+$/g, '');
}

export function isValidSlug(value: string): boolean {
  return value.length > 0 && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/** `aroma-kava`, `aroma-kava-2`, `aroma-kava-3`, ... while `taken` says the slug exists. */
export function uniqueSlug(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = slugify(`${base}-${suffix}`);
    if (!taken(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free slug for "${base}"`);
}
