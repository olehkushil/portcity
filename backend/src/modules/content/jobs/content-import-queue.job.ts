/**
 * Logic of the `content-import` queue: `POST /admin/content/import` with `async: true` creates
 * the ContentImportRun (status running) and enqueues job `run` with the request; the worker
 * executes `runContentImport` through ContentImportService and finishes the run (succeeded or
 * failed with the error). The processor only wires this plain function (unit tested).
 *
 * Idempotent: a run that is no longer `running` (finished by an earlier attempt) is skipped.
 * An import failure is recorded on the run and not retried (the same input fails again); a
 * thrown error (e.g. the run row cannot be read) makes BullMQ retry.
 */
import type { JobsOptions } from 'bullmq';
import { TENANT_STATUSES, type TenantStatus } from '../../../common/contracts/content';
import type { ContentImportItem } from '../domain/import-mapper';
import {
  CONTENT_IMPORT_SOURCES,
  type ContentImportSource,
  type ImportDefaults,
} from './content-import.job';

export const CONTENT_IMPORT_JOBS = { run: 'run' } as const;

export const CONTENT_IMPORT_JOB_OPTIONS: Readonly<JobsOptions> = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 200, age: 7 * 24 * 3_600 },
  removeOnFail: { count: 1_000, age: 30 * 24 * 3_600 },
});

/** BullMQ job ids must not contain ":". */
export function contentImportJobId(runId: string): string {
  return `content-import-${runId}`;
}

/** The import request as accepted by POST /admin/content/import (minus the async flag). */
export interface ContentImportRequest {
  source: ContentImportSource;
  dryRun?: boolean;
  items?: ContentImportItem[];
  posts?: Record<string, unknown>[];
  defaults?: Partial<ImportDefaults>;
}

export interface ContentImportJobData extends ContentImportRequest {
  runId: string;
  actor: { id: string; ip: string | null };
}

export type ContentImportJobStatus = 'succeeded' | 'failed' | 'skipped';

export interface ContentImportQueueDeps {
  /** Executes the queued run; resolves with the final status of the run. */
  execute(data: ContentImportJobData): Promise<ContentImportJobStatus>;
  log?: (message: string) => void;
}

export interface ContentImportJobResult {
  runId: string | null;
  status: ContentImportJobStatus | 'ignored';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the job data shape (it crossed Redis as JSON). */
export function parseContentImportJobData(data: unknown): ContentImportJobData | null {
  if (!isRecord(data)) {
    return null;
  }
  const { runId, actor, source } = data;
  if (typeof runId !== 'string' || runId.length === 0) {
    return null;
  }
  if (
    typeof source !== 'string' ||
    !(CONTENT_IMPORT_SOURCES as readonly string[]).includes(source)
  ) {
    return null;
  }
  if (!isRecord(actor) || typeof actor['id'] !== 'string') {
    return null;
  }
  const ip = actor['ip'];
  return {
    runId,
    source: source as ContentImportSource,
    actor: { id: actor['id'], ip: typeof ip === 'string' ? ip : null },
    ...(typeof data['dryRun'] === 'boolean' ? { dryRun: data['dryRun'] } : {}),
    ...(Array.isArray(data['items']) ? { items: data['items'] as ContentImportItem[] } : {}),
    ...(Array.isArray(data['posts'])
      ? { posts: (data['posts'] as unknown[]).filter(isRecord) }
      : {}),
    ...(isRecord(data['defaults']) ? { defaults: parseDefaults(data['defaults']) } : {}),
  };
}

function parseDefaults(raw: Record<string, unknown>): Partial<ImportDefaults> {
  const status = raw['status'];
  const participates = raw['participates'];
  return {
    ...(typeof status === 'string' && (TENANT_STATUSES as readonly string[]).includes(status)
      ? { status: status as TenantStatus }
      : {}),
    ...(typeof participates === 'boolean' ? { participates } : {}),
  };
}

/** Handler logic of the content-import processor. */
export async function handleContentImportQueueJob(
  name: string,
  data: unknown,
  deps: ContentImportQueueDeps,
): Promise<ContentImportJobResult> {
  if (name !== CONTENT_IMPORT_JOBS.run) {
    deps.log?.(`content-import: ignoring unexpected job "${name}"`);
    return { runId: null, status: 'ignored' };
  }
  const parsed = parseContentImportJobData(data);
  if (!parsed) {
    deps.log?.('content-import: malformed job data ignored');
    return { runId: null, status: 'ignored' };
  }
  const status = await deps.execute(parsed);
  deps.log?.(`content-import: run ${parsed.runId} ${status}`);
  return { runId: parsed.runId, status };
}
