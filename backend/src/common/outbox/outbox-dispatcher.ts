import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { QueueRegistry } from '../queue/queue-registry.service';
import { Clock } from '../time/clock';
import { OutboxRouter } from './outbox-router';
import {
  type OutboxDispatchResult,
  type OutboxJobData,
  type OutboxPayload,
  UNROUTED_GIVE_UP_ATTEMPTS,
} from './outbox.types';

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  type: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

/**
 * Moves unpublished outbox events into BullMQ queues (job id = `outbox-<eventId>` so a
 * re-dispatch after a crash is de-duplicated by BullMQ). Rows are locked with
 * `FOR UPDATE SKIP LOCKED`, so several worker instances can run the tick concurrently.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: OutboxRouter,
    private readonly queues: QueueRegistry,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async tick(batchSize: number = this.config.OUTBOX_BATCH_SIZE): Promise<OutboxDispatchResult> {
    return this.prisma.withTx(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, aggregate_type, aggregate_id, type, payload, occurred_at, attempts
          FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY occurred_at ASC, id ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED`;

        const result: OutboxDispatchResult = {
          fetched: rows.length,
          published: 0,
          ignored: 0,
          unrouted: 0,
          dropped: 0,
          failed: 0,
        };
        const publishedIds: string[] = [];
        const retryIds: string[] = [];

        for (const row of rows) {
          const targets = this.router.resolve(row.type);
          if (targets.length === 0 && this.router.isIgnored(row.type)) {
            // Audit-only event (src/common/outbox/audit-only-events.ts): nothing to enqueue.
            result.ignored += 1;
            publishedIds.push(row.id);
            continue;
          }
          if (targets.length === 0) {
            result.unrouted += 1;
            if (row.attempts + 1 >= UNROUTED_GIVE_UP_ATTEMPTS) {
              result.dropped += 1;
              publishedIds.push(row.id);
              this.logger.error(
                `Dropping outbox event ${row.id} (${row.type}): no consumer registered after ${row.attempts + 1} attempts`,
              );
            } else {
              retryIds.push(row.id);
              if (row.attempts === 0) {
                this.logger.warn(
                  `No consumer registered for outbox event type "${row.type}" (id ${row.id})`,
                );
              }
            }
            continue;
          }

          const data: OutboxJobData = {
            eventId: row.id,
            type: row.type,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            payload: (row.payload ?? {}) as OutboxPayload,
            occurredAt: new Date(row.occurred_at).toISOString(),
          };
          try {
            for (const queueName of targets) {
              await this.queues.get(queueName).add(row.type, data, { jobId: `outbox-${row.id}` });
            }
            publishedIds.push(row.id);
            result.published += 1;
          } catch (error) {
            retryIds.push(row.id);
            result.failed += 1;
            this.logger.error(
              `Failed to enqueue outbox event ${row.id} (${row.type}): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (publishedIds.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: publishedIds } },
            data: { publishedAt: this.clock.now() },
          });
        }
        if (retryIds.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: retryIds } },
            data: { attempts: { increment: 1 } },
          });
        }
        return result;
      },
      { timeout: 30_000 },
    );
  }
}
