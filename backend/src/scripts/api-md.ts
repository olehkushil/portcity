import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type OpenApiDocumentLike, renderApiMarkdown } from './api-markdown';

/**
 * `npm run docs:api` (= `npm run openapi` + this script): docs/openapi.json -> docs/API.md.
 * Arguments: [source=docs/openapi.json] [target=docs/API.md].
 */
function main(): void {
  const sourceArg = process.argv[2] ?? 'docs/openapi.json';
  const targetArg = process.argv[3] ?? 'docs/API.md';
  const source = resolve(process.cwd(), sourceArg);
  const target = resolve(process.cwd(), targetArg);
  const document = JSON.parse(readFileSync(source, 'utf8')) as OpenApiDocumentLike;
  const markdown = renderApiMarkdown(document, { source: sourceArg.replace(/\\/g, '/') });
  writeFileSync(target, markdown, 'utf8');
  console.log(`API summary written to ${target}`);
}

main();
