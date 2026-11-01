import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ContentImportRun, Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { ADMIN_AUDIT_PORT, type AdminAuditPort } from '../../../common/contracts/admin';
import { DomainError } from '../../../common/errors/domain-error';
import { toJsonValue } from '../../../common/idempotency/idempotency.service';
import { type Page, decodeCursor, toPage } from '../../../common/pagination/cursor';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Clock } from '../../../common/time/clock';
import { ContentErrors } from '../domain/errors';
import { type ContentImportItem, mapWordPressPosts } from '../domain/import-mapper';
import type { ListImportRunsQueryDto, RunContentImportDto } from '../dto/content-import.dto';
import type {
  ContentImportJobData,
  ContentImportJobStatus,
  ContentImportRequest,
} from '../jobs/content-import-queue.job';
import { type ContentImportStats, runContentImport } from '../jobs/content-import.job';
import { ContentImportQueue } from './content-import.queue';
import { PrismaContentImportRepository } from './content-import.repository';
import { type AdminActor, isIdCursor } from './types';

/** Items ready for `runContentImport` plus the number of WordPress posts without a title. */
interface PreparedImport {
  items: ContentImportItem[];
  skippedPosts: number;
}

/** Maps WordPress posts and validates that something importable is left. */
function prepareImport(input: ContentImportRequest): PreparedImport {
  const mapped = mapWordPressPosts(input.posts ?? []);
  const items: ContentImportItem[] = [...(input.items ?? []), ...mapped.items];
  if (items.length === 0) {
    throw new DomainError(
      ContentErrors.PC_CONTENT_IMPORT_EMPTY,
      'Provide "items" or "posts" with at least one usable entry',
      { details: { skippedPosts: mapped.skipped } },
    );
  }
  return { items, skippedPosts: mapped.skipped };
}

/** The request as it is stored in a queued job (plain JSON, no DTO instances). */
function toRequest(input: RunContentImportDto): ContentImportRequest {
  return {
    source: input.source,
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    ...(input.items !== undefined ? { items: input.items.map((item) => ({ ...item })) } : {}),
    ...(input.posts !== undefined ? { posts: input.posts } : {}),
    ...(input.defaults !== undefined ? { defaults: { ...input.defaults } } : {}),
  };
}

/**
 * WordPress import stub: runs `runContentImport` inside one transaction and records the outcome
 * in `content_import_runs` (running -> succeeded | failed). Synchronous by default; with
 * `async: true` the run is created as `running`, the request goes to the `content-import` queue
 * and the worker finishes it (`executeQueued`).
 */
@Injectable()
export class ContentImportService {
  private readonly logger = new Logger(ContentImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
    private readonly queue: ContentImportQueue,
  ) {}

  /** POST /admin/content/import: synchronous run, or a queued one when `async` is true. */
  async run(input: RunContentImportDto, actor: AdminActor): Promise<ContentImportRun> {
    const prepared = prepareImport(input);
    const run = await this.prisma.contentImportRun.create({
      data: {
        id: uuidv7(),
        source: input.source,
        status: 'running',
        startedAt: this.clock.now(),
      },
    });
    const request = toRequest(input);
    if (input.async === true) {
      try {
        await this.queue.enqueue({
          runId: run.id,
          actor: { id: actor.id, ip: actor.ip ?? null },
          ...request,
        });
      } catch (error) {
        await this.markFailed(run.id, error);
        throw error;
      }
      return run;
    }
    return this.execute(run.id, request, prepared, actor);
  }

  /**
   * Worker side of an asynchronous import (content-import queue). Idempotent: a run that is no
   * longer `running` is skipped. An import failure is recorded on the run and not rethrown.
   */
  async executeQueued(data: ContentImportJobData): Promise<ContentImportJobStatus> {
    const run = await this.prisma.contentImportRun.findUnique({ where: { id: data.runId } });
    if (!run || run.status !== 'running') {
      return 'skipped';
    }
    const actor: AdminActor = { id: data.actor.id, ip: data.actor.ip };
    try {
      await this.execute(run.id, data, prepareImport(data), actor);
      return 'succeeded';
    } catch (error) {
      this.logger.warn(
        `Queued import ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.markFailed(run.id, error);
      return 'failed';
    }
  }

  private async execute(
    runId: string,
    request: ContentImportRequest,
    prepared: PreparedImport,
    actor: AdminActor,
  ): Promise<ContentImportRun> {
    let stats: ContentImportStats;
    try {
      stats = await this.prisma.withTx((tx) =>
        runContentImport(
          {
            source: request.source,
            items: prepared.items,
            dryRun: request.dryRun ?? false,
            ...(request.defaults ? { defaults: request.defaults } : {}),
          },
          new PrismaContentImportRepository(tx, () => this.clock.now()),
        ),
      );
    } catch (error) {
      await this.markFailed(runId, error);
      throw error;
    }
    if (prepared.skippedPosts > 0) {
      stats.warnings.push(`${prepared.skippedPosts} WordPress post(s) without a title skipped`);
    }
    const finished = await this.prisma.contentImportRun.update({
      where: { id: runId },
      data: {
        status: 'succeeded',
        finishedAt: this.clock.now(),
        stats: toJsonValue(stats) as Prisma.InputJsonObject,
      },
    });
    await this.audit.audit({
      actor: { type: 'admin', id: actor.id },
      action: 'content_import.run',
      entityType: 'content_import_run',
      entityId: runId,
      after: {
        source: stats.source,
        dryRun: stats.dryRun,
        received: stats.received,
        created: stats.created,
        updated: stats.updated,
        unchanged: stats.unchanged,
        invalid: stats.invalid,
      },
      ip: actor.ip ?? null,
    });
    return finished;
  }

  async list(query: ListImportRunsQueryDto): Promise<Page<ContentImportRun>> {
    const cursor = decodeCursor(query.cursor, isIdCursor);
    const rows = await this.prisma.contentImportRun.findMany({
      where: {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(cursor ? { id: { lt: cursor.id } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, (last) => ({ id: last.id }));
  }

  async getById(id: string): Promise<ContentImportRun> {
    const row = await this.prisma.contentImportRun.findUnique({ where: { id } });
    if (!row) {
      throw new DomainError(ContentErrors.PC_CONTENT_IMPORT_NOT_FOUND, 'Import run not found', {
        details: { id },
      });
    }
    return row;
  }

  private async markFailed(runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.prisma.contentImportRun.update({
        where: { id: runId },
        data: { status: 'failed', finishedAt: this.clock.now(), error: message.slice(0, 2000) },
      });
    } catch (updateError) {
      this.logger.error(
        `Could not mark import run ${runId} as failed: ${
          updateError instanceof Error ? updateError.message : String(updateError)
        }`,
      );
    }
  }
}
