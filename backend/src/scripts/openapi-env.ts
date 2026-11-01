/**
 * Side-effect module imported FIRST by src/scripts/openapi.ts: boots the app without
 * PostgreSQL or Redis so the OpenAPI document can be generated in CI.
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
process.env.PRISMA_LAZY_CONNECT = 'true';
process.env.QUEUE_DRIVER = 'memory';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER ?? 'memory';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
process.env.LOG_PRETTY = 'false';
process.env.DOCS_ENABLED = 'true';
