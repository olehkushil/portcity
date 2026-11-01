import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { Clock } from '../time/clock';
import { type OutboxEventInput, assertOutboxEventType } from './outbox.types';

/**
 * Transactional outbox producer (brief section 3). Call `publish(tx, event)` inside the same
 * transaction that changes the aggregate; the worker's dispatcher forwards the event to the
 * queues registered in OutboxRouter.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Inserts the event and returns its id. */
  async publish(tx: Tx, event: OutboxEventInput): Promise<string> {
    assertOutboxEventType(event.type);
    const id = uuidv7();
    await tx.outboxEvent.create({
      data: {
        id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        type: event.type,
        // Payloads are plain JSON objects by contract (OutboxPayload).
        payload: event.payload as Prisma.InputJsonObject,
        occurredAt: event.occurredAt ?? this.clock.now(),
      },
    });
    return id;
  }

  async publishMany(tx: Tx, events: OutboxEventInput[]): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) {
      ids.push(await this.publish(tx, event));
    }
    return ids;
  }

  /** Deletes published events older than `olderThan`; returns the number removed. */
  async purgePublished(olderThan: Date): Promise<number> {
    const result = await this.prisma.outboxEvent.deleteMany({
      where: { publishedAt: { not: null, lt: olderThan } },
    });
    return result.count;
  }

  async countUnpublished(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { publishedAt: null } });
  }
}
