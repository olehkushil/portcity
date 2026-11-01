import { Injectable } from '@nestjs/common';

export interface OutboxRoute {
  pattern: string;
  queue: string;
}

const SEGMENT_PATTERN = /^(?:[a-z][a-z0-9_]*|\*|\*\*)$/;

/**
 * Pattern matching for event types:
 * - exact: `receipt.credited`
 * - one segment wildcard: `receipt.*` matches `receipt.credited`, not `receipt.credited.extra`
 * - tail wildcard: `parking.**` matches `parking.session.payable`
 */
export function matchesEventPattern(pattern: string, type: string): boolean {
  if (pattern === type) {
    return true;
  }
  const patternSegments = pattern.split('.');
  const typeSegments = type.split('.');
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];
    if (segment === '**') {
      return index === patternSegments.length - 1 && typeSegments.length > index;
    }
    if (index >= typeSegments.length) {
      return false;
    }
    if (segment !== '*' && segment !== typeSegments[index]) {
      return false;
    }
  }
  return patternSegments.length === typeSegments.length;
}

export function assertEventPattern(pattern: string): void {
  const segments = pattern.split('.');
  if (segments.length < 2 || !segments.every((segment) => SEGMENT_PATTERN.test(segment))) {
    throw new Error(`Invalid outbox route pattern "${pattern}"`);
  }
  if (segments.slice(0, -1).includes('**')) {
    throw new Error(`Invalid outbox route pattern "${pattern}": "**" may only be the last segment`);
  }
}

/**
 * Maps event types to consumer queues. The consuming module registers its routes in
 * `onModuleInit`, e.g. `router.addRoute('receipt.credited', QUEUES.notificationsPush)`.
 * One event may fan out to several queues.
 */
@Injectable()
export class OutboxRouter {
  private readonly entries: OutboxRoute[] = [];
  /** Exact event types published for the audit trail only (no consumer by design) -> reason. */
  private readonly auditOnly = new Map<string, string>();

  /**
   * Declares an event type that has no consumer on purpose (it documents a fact in the outbox
   * table). The dispatcher marks such events published right away instead of retrying them for
   * five minutes and logging an error. A route registered for the same type still wins.
   */
  ignore(type: string, reason: string): this {
    assertEventPattern(type);
    if (type.includes('*')) {
      throw new Error(`Audit-only outbox type "${type}" must be an exact type, not a pattern`);
    }
    this.auditOnly.set(type, reason);
    return this;
  }

  /** True when `type` was declared audit-only with `ignore()`. */
  isIgnored(type: string): boolean {
    return this.auditOnly.has(type);
  }

  listIgnored(): ReadonlyMap<string, string> {
    return new Map(this.auditOnly);
  }

  addRoute(pattern: string, queue: string): this {
    assertEventPattern(pattern);
    if (!queue) {
      throw new Error(`Outbox route "${pattern}" needs a queue name`);
    }
    if (!this.entries.some((entry) => entry.pattern === pattern && entry.queue === queue)) {
      this.entries.push({ pattern, queue });
    }
    return this;
  }

  addRoutes(routes: Record<string, string | string[]>): this {
    for (const [pattern, queues] of Object.entries(routes)) {
      for (const queue of Array.isArray(queues) ? queues : [queues]) {
        this.addRoute(pattern, queue);
      }
    }
    return this;
  }

  /** Queues that must receive `type`, de-duplicated, in registration order. */
  resolve(type: string): string[] {
    const queues: string[] = [];
    for (const entry of this.entries) {
      if (matchesEventPattern(entry.pattern, type) && !queues.includes(entry.queue)) {
        queues.push(entry.queue);
      }
    }
    return queues;
  }

  list(): readonly OutboxRoute[] {
    return [...this.entries];
  }
}
