import { isValidSlug, slugify, transliterate, uniqueSlug } from './slug';

describe('slugify', () => {
  const cases: ReadonlyArray<[string, string]> = [
    ['INTERTOP', 'intertop'],
    ['Aroma Kava', 'aroma-kava'],
    ['Coffee & Gelato', 'coffee-gelato'],
    ['Premier City', 'premier-city'],
    ['Strike City', 'strike-city'],
    ['Figli Migli', 'figli-migli'],
    ['ТамТам', 'tamtam'],
    ['Фіглі Міглі', 'fihli-mihli'],
    ['Їжак & Єнот', 'yizhak-yenot'],
    ['Південний Юпітер', 'pivdennyi-yupiter'],
    ['Київ', 'kyiv'],
    ['Запоріжжя', 'zaporizhzhia'],
    ["М'ясна лавка", 'miasna-lavka'],
    ['  Café   Crème  ', 'cafe-creme'],
    ['Zara Home 2', 'zara-home-2'],
    ['---', ''],
    ['!!!', ''],
    ['Ґудзик', 'gudzyk'],
    ['Щука', 'shchuka'],
  ];

  it.each(cases)('%p -> %p', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('truncates to the column length without a trailing hyphen', () => {
    const long = Array.from({ length: 40 }, () => 'abc').join(' ');
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(100);
    expect(slug.endsWith('-')).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('transliterate keeps Latin text as is (lowercased)', () => {
    expect(transliterate('Hello World')).toBe('hello world');
  });
});

describe('isValidSlug', () => {
  it.each([
    ['aroma-kava', true],
    ['intertop', true],
    ['zara-home-2', true],
    ['', false],
    ['Aroma', false],
    ['aroma--kava', false],
    ['-aroma', false],
    ['aroma-', false],
    ['aroma kava', false],
    ['a'.repeat(101), false],
  ])('%p -> %s', (slug, expected) => {
    expect(isValidSlug(slug)).toBe(expected);
  });
});

describe('uniqueSlug', () => {
  it('returns the base when free', () => {
    expect(uniqueSlug('aroma-kava', () => false)).toBe('aroma-kava');
  });

  it('appends an increasing suffix while taken', () => {
    const taken = new Set(['aroma-kava', 'aroma-kava-2']);
    expect(uniqueSlug('aroma-kava', (candidate) => taken.has(candidate))).toBe('aroma-kava-3');
  });
});
