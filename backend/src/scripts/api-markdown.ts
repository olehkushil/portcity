/**
 * Renders docs/API.md (endpoint tables grouped by OpenAPI tag) from the document written by
 * `npm run openapi`. Pure: no Nest, no file system. The CLI wrapper is src/scripts/api-md.ts.
 */

export interface OpenApiParameterLike {
  name: string;
  in: string;
  required?: boolean;
}

export interface OpenApiOperationLike {
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameterLike[];
  /** `member | admin | public`, set by @Auth() / @Public() (src/common/auth/auth.decorators.ts). */
  'x-auth'?: string;
  /** Admin roles allowed by @Auth('admin', ...roles) or @Roles(); `owner` always passes. */
  'x-roles'?: string[];
}

export interface OpenApiDocumentLike {
  info?: { title?: string; version?: string };
  tags?: Array<{ name: string; description?: string }>;
  /** Path items also hold non-operation keys (`parameters`, `summary`); they are skipped. */
  paths: Record<string, Record<string, unknown>>;
}

interface Row {
  tag: string;
  method: string;
  path: string;
  summary: string;
  access: string;
  idempotent: boolean;
  deprecated: boolean;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Ukrainian section titles; unknown tags keep their own name. */
export const TAG_TITLES_UK: Readonly<Record<string, string>> = Object.freeze({
  ops: 'Службові (health, readiness)',
  auth: 'Вхід і профіль учасника (identity)',
  club: 'Клубний рахунок і бали (club)',
  receipts: 'Чеки (receipts)',
  rewards: 'Винагороди (rewards)',
  vouchers: 'Ваучери учасника (rewards)',
  validator: 'Валідатор на касі (rewards)',
  promos: 'Акції та події (promos)',
  parking: 'Паркінг (parking)',
  payments: 'Платежі (payments)',
  notifications: 'Сповіщення (notifications)',
  content: 'Орендарі та ТРЦ (content)',
  admin: 'Бек-офіс (/admin, токен адміністратора)',
});

function isOperation(value: unknown): value is OpenApiOperationLike {
  return typeof value === 'object' && value !== null;
}

function securitySchemes(operation: OpenApiOperationLike): string[] {
  return (operation.security ?? []).flatMap((requirement) => Object.keys(requirement));
}

export function describeAccess(operation: OpenApiOperationLike): string {
  const kind = operation['x-auth'];
  const roles = operation['x-roles'] ?? [];
  if (kind === 'admin') {
    return roles.length > 0 ? `admin: ${roles.join(', ')}` : 'admin: будь-яка роль';
  }
  if (kind === 'member') {
    return 'учасник';
  }
  if (kind === 'public') {
    return 'публічний';
  }
  if (kind === 'optional') {
    return 'гість або учасник';
  }
  const schemes = securitySchemes(operation);
  if (schemes.includes('validator-key')) {
    const extra = schemes.filter((scheme) => scheme !== 'validator-key');
    return extra.length > 0 ? 'валідатор: ключ + токен зміни' : 'валідатор: ключ пристрою';
  }
  if (schemes.includes('bearer')) {
    return 'токен';
  }
  return 'публічний';
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function collectRows(document: OpenApiDocumentLike): Row[] {
  const rows: Row[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isOperation(operation)) {
        continue;
      }
      const access = describeAccess(operation);
      rows.push({
        tag: operation.tags?.[0] ?? 'other',
        method: method.toUpperCase(),
        path,
        summary: escapeCell(operation.summary ?? operation.description ?? ''),
        // Provider webhooks are public routes guarded by the provider's signature header.
        access:
          path.includes('/webhooks/') && access === 'публічний' ? 'підпис провайдера' : access,
        idempotent: (operation.parameters ?? []).some(
          (parameter) =>
            parameter.in === 'header' &&
            parameter.name.toLowerCase() === 'idempotency-key' &&
            parameter.required === true,
        ),
        deprecated: operation.deprecated === true,
      });
    }
  }
  return rows;
}

function orderedTags(document: OpenApiDocumentLike, rows: readonly Row[]): string[] {
  const declared = (document.tags ?? []).map((tag) => tag.name);
  const used = new Set(rows.map((row) => row.tag));
  const extra = [...used].filter((tag) => !declared.includes(tag)).sort();
  return [...declared.filter((tag) => used.has(tag)), ...extra];
}

function compareRows(a: Row, b: Row): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  return (
    HTTP_METHODS.indexOf(a.method.toLowerCase() as (typeof HTTP_METHODS)[number]) -
    HTTP_METHODS.indexOf(b.method.toLowerCase() as (typeof HTTP_METHODS)[number])
  );
}

function table(rows: readonly Row[]): string[] {
  const lines = [
    '| Метод | Шлях | Опис | Доступ | Idempotency-Key |',
    '| ----- | ---- | ---- | ------ | --------------- |',
  ];
  for (const row of [...rows].sort(compareRows)) {
    const summary = row.deprecated ? `${row.summary} (застаріле)` : row.summary;
    lines.push(
      `| ${row.method} | \`${row.path}\` | ${summary} | ${row.access} | ${row.idempotent ? 'так' : ''} |`,
    );
  }
  return lines;
}

/** Back-office group of an admin path: `/api/v1/admin/receipts/:id` -> `receipts`. */
function adminGroup(path: string): string {
  const match = /\/admin\/([^/]+)/.exec(path);
  return match?.[1] ?? 'інше';
}

export interface RenderOptions {
  /** Shown in the header, e.g. `docs/openapi.json`. */
  source?: string;
}

export function renderApiMarkdown(
  document: OpenApiDocumentLike,
  options: RenderOptions = {},
): string {
  const rows = collectRows(document);
  const tags = orderedTags(document, rows);
  const descriptions = new Map((document.tags ?? []).map((tag) => [tag.name, tag.description]));
  const title = document.info?.title ?? 'API';
  const version = document.info?.version ?? '';
  const out: string[] = [];

  out.push('# API PortCity backend');
  out.push('');
  out.push(
    `Згенеровано з \`${options.source ?? 'docs/openapi.json'}\` (${title}${version ? ` ${version}` : ''}) ` +
      'командою `npm run docs:api`; не редагуйте файл вручну. Повний опис запитів і відповідей - ' +
      'Swagger UI на `/docs` або сам `docs/openapi.json`.',
  );
  out.push('');
  out.push(
    'Усі бізнес-ендпоїнти мають префікс `/api/v1`; помилки - `application/problem+json` з кодом ' +
      '`PC_<MODULE>_<REASON>`. "Доступ": `учасник` - access-токен учасника, `admin: ролі` - токен ' +
      'адміністратора з однією з ролей (роль `owner` проходить будь-яку перевірку), `валідатор` - ' +
      'заголовок `X-Validator-Key` пристрою каси. Позначка в колонці Idempotency-Key означає ' +
      'обов’язковий заголовок `Idempotency-Key`.',
  );
  out.push('');
  out.push(`Ендпоїнтів: ${rows.length}.`);
  out.push('');
  out.push('| Розділ | Тег | Ендпоїнтів |');
  out.push('| ------ | --- | ---------- |');
  for (const tag of tags) {
    const count = rows.filter((row) => row.tag === tag).length;
    out.push(`| ${TAG_TITLES_UK[tag] ?? tag} | \`${tag}\` | ${count} |`);
  }

  for (const tag of tags) {
    const tagRows = rows.filter((row) => row.tag === tag);
    out.push('');
    out.push(`## ${TAG_TITLES_UK[tag] ?? tag}`);
    const description = descriptions.get(tag);
    if (description) {
      out.push('');
      out.push(`Тег \`${tag}\`: ${description}.`);
    }
    if (tag === 'admin') {
      const groups = [...new Set(tagRows.map((row) => adminGroup(row.path)))].sort();
      for (const group of groups) {
        out.push('');
        out.push(`### /admin/${group}`);
        out.push('');
        out.push(...table(tagRows.filter((row) => adminGroup(row.path) === group)));
      }
    } else {
      out.push('');
      out.push(...table(tagRows));
    }
  }
  out.push('');
  return out.join('\n');
}
