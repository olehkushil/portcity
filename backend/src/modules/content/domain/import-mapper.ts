import { TENANT_CATEGORIES, type TenantCategory } from '../../../common/contracts/content';
import { isValidSlug, slugify } from './slug';

/**
 * WordPress import stub (brief section 4, `ContentImportRun`): pure mapping of site catalogue
 * entries to tenant fields. Fetching from the site is not implemented (no REST access yet);
 * the admin endpoint receives either already-shaped items or raw `wp/v2` posts.
 */

/** One catalogue entry as accepted by POST /admin/content/import-runs. */
export interface ContentImportItem {
  slug?: string | null;
  name: string;
  category?: string | null;
  floor?: number | string | null;
  website?: string | null;
  phone?: string | null;
  description?: string | null;
  logoKey?: string | null;
  externalId?: string | null;
}

/** Tenant columns an import may write. Program fields (participates, rate, exclusion) never. */
export interface ImportableTenantFields {
  name: string;
  category: string;
  floor: number | null;
  website: string | null;
  phone: string | null;
  description: string | null;
  logoKey: string | null;
}

export const IMPORTABLE_FIELDS: ReadonlyArray<keyof ImportableTenantFields> = [
  'name',
  'category',
  'floor',
  'website',
  'phone',
  'description',
  'logoKey',
];

export interface NormalizedImportItem extends ImportableTenantFields {
  slug: string;
  category: TenantCategory;
  /** False when the category text was not recognised and `other` was substituted. */
  categoryRecognised: boolean;
  externalId: string | null;
}

export type ImportItemResult =
  { ok: true; item: NormalizedImportItem; warnings: string[] } | { ok: false; issue: string };

export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 4000;
export const PHONE_MAX_LENGTH = 32;
export const WEBSITE_MAX_LENGTH = 500;
export const FLOOR_MIN = -3;
export const FLOOR_MAX = 30;

/** Ukrainian and English category words seen on the mall site, lowercased. */
const CATEGORY_SYNONYMS: ReadonlyArray<[TenantCategory, readonly string[]]> = [
  ['fashion', ['fashion', 'одяг', 'взуття', 'мода', 'clothes', 'shoes', 'аксесуари']],
  ['coffee', ['coffee', 'кава', 'кав', 'кафе', 'cafe', 'кондитерська']],
  ['cinema', ['cinema', 'кіно', 'кінотеатр']],
  ['bowling', ['bowling', 'боулінг']],
  ['entertainment', ['entertainment', 'розваги', 'розважальний', 'ігри', 'квест']],
  ['kids', ['kids', 'діти', 'дитячий', 'дитяч', 'іграшки']],
  ['hypermarket', ['hypermarket', 'гіпермаркет', 'супермаркет', 'продукти', 'grocery']],
  ['sport', ['sport', 'спорт', 'фітнес', 'fitness']],
  ['electronics', ['electronics', 'електроніка', 'техніка', 'гаджети']],
  ['beauty', ['beauty', 'краса', 'косметика', 'парфумерія', 'салон']],
  ['pharmacy', ['pharmacy', 'аптека', 'здоров']],
  ['home', ['home', 'дім', 'дому', 'меблі', 'декор', 'інтер']],
  ['food_court', ['food_court', 'food court', 'фудкорт', 'фуд-корт', 'ресторан', 'їжа', 'піца']],
  ['services', ['services', 'послуги', 'сервіс', 'банк', 'оператор']],
];

export function normalizeCategory(raw: string | null | undefined): {
  category: TenantCategory;
  recognised: boolean;
} {
  const text = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (text === '') {
    return { category: 'other', recognised: false };
  }
  if ((TENANT_CATEGORIES as readonly string[]).includes(text)) {
    return { category: text as TenantCategory, recognised: true };
  }
  const loose = text.replace(/_/g, ' ');
  for (const [category, words] of CATEGORY_SYNONYMS) {
    if (words.some((word) => loose.includes(word.replace(/_/g, ' ')))) {
      return { category, recognised: true };
    }
  }
  return { category: 'other', recognised: false };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  ldquo: '“',
  rdquo: '”',
  rsquo: '’',
  lsquo: '‘',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

/** Removes tags, decodes entities and collapses whitespace. */
export function stripHtml(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = stripHtml(value);
  if (text === '') {
    return null;
  }
  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}

function parseFloor(value: unknown): { floor: number | null; invalid: boolean } {
  if (value === null || value === undefined || value === '') {
    return { floor: null, invalid: false };
  }
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(numeric) || numeric < FLOOR_MIN || numeric > FLOOR_MAX) {
    return { floor: null, invalid: true };
  }
  return { floor: numeric, invalid: false };
}

function cleanWebsite(value: unknown): { website: string | null; invalid: boolean } {
  if (typeof value !== 'string' || value.trim() === '') {
    return { website: null, invalid: false };
  }
  const text = value.trim();
  if (text.length > WEBSITE_MAX_LENGTH) {
    return { website: null, invalid: true };
  }
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { website: null, invalid: true };
    }
    return { website: url.toString(), invalid: false };
  } catch {
    return { website: null, invalid: true };
  }
}

/** Validates and normalises one import item; `index` is used in messages. Never throws. */
export function normalizeImportItem(raw: ContentImportItem, index: number): ImportItemResult {
  const warnings: string[] = [];
  const name = cleanText(raw.name, NAME_MAX_LENGTH);
  if (name === null) {
    return { ok: false, issue: `item ${index}: name is required` };
  }
  const slugSource = typeof raw.slug === 'string' && raw.slug.trim() !== '' ? raw.slug : name;
  const slug = isValidSlug(slugSource) ? slugSource : slugify(slugSource);
  if (!isValidSlug(slug)) {
    return { ok: false, issue: `item ${index} (${name}): cannot derive a slug` };
  }
  if (slug !== slugSource.trim()) {
    warnings.push(`item ${index} (${name}): slug normalised to "${slug}"`);
  }

  const { category, recognised } = normalizeCategory(raw.category);
  if (!recognised && raw.category) {
    warnings.push(`item ${index} (${name}): unknown category "${raw.category}", using "other"`);
  }

  const floorResult = parseFloor(raw.floor);
  if (floorResult.invalid) {
    warnings.push(`item ${index} (${name}): floor "${String(raw.floor)}" ignored`);
  }

  const websiteResult = cleanWebsite(raw.website);
  if (websiteResult.invalid) {
    warnings.push(`item ${index} (${name}): website "${String(raw.website)}" ignored`);
  }

  const logoKey =
    typeof raw.logoKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}$/.test(raw.logoKey)
      ? raw.logoKey
      : null;
  if (raw.logoKey && logoKey === null) {
    warnings.push(`item ${index} (${name}): logoKey ignored (not a storage key)`);
  }

  return {
    ok: true,
    warnings,
    item: {
      slug,
      name,
      category,
      categoryRecognised: recognised,
      floor: floorResult.floor,
      website: websiteResult.website,
      phone: cleanText(raw.phone, PHONE_MAX_LENGTH),
      description: cleanText(raw.description, DESCRIPTION_MAX_LENGTH),
      logoKey,
      externalId:
        raw.externalId === null || raw.externalId === undefined ? null : String(raw.externalId),
    },
  };
}

/** First occurrence of a slug wins; later duplicates are reported. */
export function dedupeImportItems(items: readonly NormalizedImportItem[]): {
  items: NormalizedImportItem[];
  duplicates: string[];
} {
  const seen = new Set<string>();
  const unique: NormalizedImportItem[] = [];
  const duplicates: string[] = [];
  for (const item of items) {
    if (seen.has(item.slug)) {
      duplicates.push(item.slug);
      continue;
    }
    seen.add(item.slug);
    unique.push(item);
  }
  return { items: unique, duplicates };
}

/**
 * Fields to update on an existing tenant: only values the import actually provides
 * (an empty site field never erases curated data) and only when they differ. A guessed
 * category (`other`) never replaces a curated one.
 */
export function diffImportedTenant(
  existing: ImportableTenantFields,
  incoming: NormalizedImportItem,
): Partial<ImportableTenantFields> {
  const patch: Partial<ImportableTenantFields> = {};
  if (incoming.name !== existing.name) {
    patch.name = incoming.name;
  }
  if (incoming.categoryRecognised && incoming.category !== existing.category) {
    patch.category = incoming.category;
  }
  for (const field of ['floor', 'website', 'phone', 'description', 'logoKey'] as const) {
    const value = incoming[field];
    if (value !== null && value !== existing[field]) {
      (patch as Record<string, unknown>)[field] = value;
    }
  }
  return patch;
}

function readRendered(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'rendered' in value) {
    const rendered = (value as { rendered?: unknown }).rendered;
    return typeof rendered === 'string' ? rendered : null;
  }
  return null;
}

function readField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Maps a `wp/v2` post (standard or custom post type) to an import item. Custom fields are
 * read from `acf` or `meta`; a post without a title is skipped (null).
 */
export function mapWordPressPost(post: unknown): ContentImportItem | null {
  const record = asRecord(post);
  if (!record) {
    return null;
  }
  const title = readRendered(record['title']);
  if (title === null || stripHtml(title) === '') {
    return null;
  }
  const custom = asRecord(record['acf']) ?? asRecord(record['meta']) ?? {};
  const floor = readField(custom, ['floor', 'poverkh', 'level']);
  const category = readField(custom, ['category', 'kategoriya', 'type']);
  const categoryNames = record['categories_names'];
  const categoryFromNames =
    Array.isArray(categoryNames) && typeof categoryNames[0] === 'string'
      ? categoryNames[0]
      : undefined;
  const website = readField(custom, ['website', 'site', 'url']);
  const phone = readField(custom, ['phone', 'telefon', 'tel']);
  const description = readRendered(record['excerpt']) ?? readRendered(record['content']);
  const slug = record['slug'];
  const id = record['id'];

  return {
    slug: typeof slug === 'string' ? slug : null,
    name: title,
    category:
      typeof category === 'string'
        ? category
        : typeof categoryFromNames === 'string'
          ? categoryFromNames
          : null,
    floor: typeof floor === 'number' || typeof floor === 'string' ? floor : null,
    website: typeof website === 'string' ? website : null,
    phone: typeof phone === 'string' ? phone : null,
    description,
    externalId: typeof id === 'number' || typeof id === 'string' ? String(id) : null,
  };
}

export function mapWordPressPosts(posts: readonly unknown[]): {
  items: ContentImportItem[];
  skipped: number;
} {
  const items: ContentImportItem[] = [];
  let skipped = 0;
  for (const post of posts) {
    const item = mapWordPressPost(post);
    if (item) {
      items.push(item);
    } else {
      skipped += 1;
    }
  }
  return { items, skipped };
}
