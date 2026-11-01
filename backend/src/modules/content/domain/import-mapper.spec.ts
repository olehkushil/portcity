import {
  decodeHtmlEntities,
  dedupeImportItems,
  diffImportedTenant,
  mapWordPressPost,
  mapWordPressPosts,
  normalizeCategory,
  normalizeImportItem,
  stripHtml,
  type NormalizedImportItem,
} from './import-mapper';

describe('normalizeCategory', () => {
  it.each([
    ['fashion', 'fashion', true],
    ['Food Court', 'food_court', true],
    ['food-court', 'food_court', true],
    ['Одяг та взуття', 'fashion', true],
    ['Кав’ярня', 'coffee', true],
    ['Кінотеатр', 'cinema', true],
    ['Дитячий світ', 'kids', true],
    ['Аптека', 'pharmacy', true],
    ['Гіпермаркет', 'hypermarket', true],
    ['Спорт і фітнес', 'sport', true],
    ['Електроніка', 'electronics', true],
    ['Краса та здоров’я', 'beauty', true],
    ['Меблі та декор', 'home', true],
    ['Ресторани', 'food_court', true],
    ['Банк', 'services', true],
    ['Quantum chromodynamics', 'other', false],
    ['', 'other', false],
    [null, 'other', false],
    [undefined, 'other', false],
  ])('%p -> %s (recognised %s)', (input, category, recognised) => {
    expect(normalizeCategory(input)).toEqual({ category, recognised });
  });
});

describe('html helpers', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeHtmlEntities('Coffee &amp; Gelato &#8211; &#x41;&quot;&unknown;')).toBe(
      'Coffee & Gelato – A"&unknown;',
    );
  });

  it('strips tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello&nbsp;<b>world</b>\n\n</p> ')).toBe('Hello world');
  });
});

describe('normalizeImportItem', () => {
  it('normalises a complete item', () => {
    const result = normalizeImportItem(
      {
        slug: 'Aroma Kava',
        name: ' Aroma&amp;Kava ',
        category: 'Кава',
        floor: '1',
        website: 'aromakava.ua',
        phone: '+380 50 000 00 00',
        description: '<p>Кава з собою</p>',
        externalId: 42,
      } as never,
      0,
    );
    expect(result).toEqual({
      ok: true,
      warnings: ['item 0 (Aroma&Kava): slug normalised to "aroma-kava"'],
      item: {
        slug: 'aroma-kava',
        name: 'Aroma&Kava',
        category: 'coffee',
        categoryRecognised: true,
        floor: 1,
        website: 'https://aromakava.ua/',
        phone: '+380 50 000 00 00',
        description: 'Кава з собою',
        logoKey: null,
        externalId: '42',
      },
    });
  });

  it('derives the slug from the name when missing', () => {
    const result = normalizeImportItem({ name: 'Premier City' }, 3);
    expect(result.ok && result.item.slug).toBe('premier-city');
    expect(result.ok && result.item.category).toBe('other');
    expect(result.ok && result.warnings).toEqual([
      'item 3 (Premier City): slug normalised to "premier-city"',
    ]);
  });

  it('rejects items without a name or slug', () => {
    expect(normalizeImportItem({ name: '   ' }, 1)).toEqual({
      ok: false,
      issue: 'item 1: name is required',
    });
    expect(normalizeImportItem({ name: '!!!' }, 2)).toEqual({
      ok: false,
      issue: 'item 2 (!!!): cannot derive a slug',
    });
  });

  it('ignores bad floors, websites, logo keys and unknown categories with warnings', () => {
    const result = normalizeImportItem(
      {
        slug: 'shop',
        name: 'Shop',
        category: 'Mysterious',
        floor: 'penthouse',
        website: 'not a url at all',
        logoKey: '../etc/passwd',
      },
      5,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item).toMatchObject({
        floor: null,
        website: null,
        logoKey: null,
        category: 'other',
        categoryRecognised: false,
      });
      expect(result.warnings).toEqual([
        'item 5 (Shop): unknown category "Mysterious", using "other"',
        'item 5 (Shop): floor "penthouse" ignored',
        'item 5 (Shop): website "not a url at all" ignored',
        'item 5 (Shop): logoKey ignored (not a storage key)',
      ]);
    }
  });

  it('truncates long names and descriptions', () => {
    const result = normalizeImportItem(
      { slug: 'long', name: 'n'.repeat(300), description: 'd'.repeat(5000) },
      0,
    );
    expect(result.ok && result.item.name.length).toBe(200);
    expect(result.ok && result.item.description?.length).toBe(4000);
  });
});

describe('dedupeImportItems', () => {
  const item = (slug: string): NormalizedImportItem => ({
    slug,
    name: slug,
    category: 'other',
    categoryRecognised: false,
    floor: null,
    website: null,
    phone: null,
    description: null,
    logoKey: null,
    externalId: null,
  });

  it('keeps the first occurrence and reports the rest', () => {
    const result = dedupeImportItems([item('a'), item('b'), item('a'), item('a')]);
    expect(result.items.map((i) => i.slug)).toEqual(['a', 'b']);
    expect(result.duplicates).toEqual(['a', 'a']);
  });
});

describe('diffImportedTenant', () => {
  const existing = {
    name: 'INTERTOP',
    category: 'fashion',
    floor: 1,
    website: 'https://intertop.ua',
    phone: null,
    description: null,
    logoKey: 'tenants/intertop.png',
  };
  const incoming: NormalizedImportItem = {
    slug: 'intertop',
    name: 'INTERTOP',
    category: 'other',
    categoryRecognised: false,
    floor: 2,
    website: null,
    phone: '+380332000000',
    description: null,
    logoKey: null,
    externalId: '1',
  };

  it('updates provided differing values only and keeps curated category', () => {
    expect(diffImportedTenant(existing, incoming)).toEqual({ floor: 2, phone: '+380332000000' });
  });

  it('replaces the category when the import recognised it', () => {
    expect(
      diffImportedTenant(existing, { ...incoming, category: 'sport', categoryRecognised: true }),
    ).toEqual({ category: 'sport', floor: 2, phone: '+380332000000' });
  });

  it('is empty when nothing changes', () => {
    expect(
      diffImportedTenant(existing, {
        ...incoming,
        floor: 1,
        phone: null,
      }),
    ).toEqual({});
  });
});

describe('mapWordPressPost', () => {
  it('maps a custom post with acf fields', () => {
    expect(
      mapWordPressPost({
        id: 77,
        slug: 'coffee-gelato',
        title: { rendered: 'Coffee &amp; Gelato' },
        excerpt: { rendered: '<p>Морозиво та кава</p>' },
        acf: { floor: '2', category: 'Кава', phone: '0332 123456', website: 'https://cg.ua' },
      }),
    ).toEqual({
      slug: 'coffee-gelato',
      name: 'Coffee &amp; Gelato',
      category: 'Кава',
      floor: '2',
      website: 'https://cg.ua',
      phone: '0332 123456',
      description: '<p>Морозиво та кава</p>',
      externalId: '77',
    });
  });

  it('falls back to meta, categories_names and content', () => {
    expect(
      mapWordPressPost({
        id: '8',
        title: 'Strike City',
        content: { rendered: 'Боулінг' },
        categories_names: ['Розваги'],
        meta: { level: 3 },
      }),
    ).toEqual({
      slug: null,
      name: 'Strike City',
      category: 'Розваги',
      floor: 3,
      website: null,
      phone: null,
      description: 'Боулінг',
      externalId: '8',
    });
  });

  it('skips posts without a title and non-objects', () => {
    expect(mapWordPressPost({ id: 1, title: { rendered: '' } })).toBe(null);
    expect(mapWordPressPost('text')).toBe(null);
    expect(mapWordPressPost(null)).toBe(null);
    expect(mapWordPressPosts([{ title: 'A' }, null, 5])).toEqual({
      items: [expect.objectContaining({ name: 'A' })],
      skipped: 2,
    });
  });
});
