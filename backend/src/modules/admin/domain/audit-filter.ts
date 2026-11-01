import { AUDIT_ACTION_PATTERN } from '../../../common/contracts/admin';
import { ACTOR_TYPES, type ActorType } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { CommonErrors } from '../../../common/errors/error-codes';
import { AdminErrors } from './errors';

/**
 * Filters of GET /admin/audit, normalised and validated before they reach Prisma.
 * The action filter accepts an exact action (`tenant.update`) or a prefix (`tenant.*`).
 */

export const AUDIT_ACTION_PREFIX_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.\*$/;

export type AuditActionMatch = { kind: 'exact'; value: string } | { kind: 'prefix'; value: string };

export interface AuditFilterInput {
  entityType?: string;
  entityId?: string;
  actorType?: string;
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

export interface AuditFilter {
  entityType?: string;
  entityId?: string;
  actorType?: ActorType;
  actorId?: string;
  action?: AuditActionMatch;
  from?: Date;
  to?: Date;
}

export function parseAuditAction(raw: string): AuditActionMatch {
  const value = raw.trim();
  if (AUDIT_ACTION_PATTERN.test(value)) {
    return { kind: 'exact', value };
  }
  if (AUDIT_ACTION_PREFIX_PATTERN.test(value)) {
    return { kind: 'prefix', value: value.slice(0, -1) };
  }
  throw new DomainError(
    AdminErrors.PC_AUDIT_ACTION_INVALID,
    `Audit action filter "${raw}" must be "<entity>.<verb>" or a prefix such as "tenant.*"`,
    { details: { action: raw } },
  );
}

function validationError(path: string, message: string): DomainError {
  return new DomainError(CommonErrors.PC_COMMON_VALIDATION, 'Request validation failed', {
    details: [{ path, messages: [message] }],
  });
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isActorType(value: string): value is ActorType {
  return (ACTOR_TYPES as readonly string[]).includes(value);
}

function validDate(value: Date | undefined, path: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw validationError(path, `${path} must be an ISO 8601 timestamp`);
  }
  return value;
}

export function normaliseAuditFilter(input: AuditFilterInput): AuditFilter {
  const filter: AuditFilter = {};
  const entityType = clean(input.entityType);
  if (entityType) {
    filter.entityType = entityType;
  }
  const entityId = clean(input.entityId);
  if (entityId) {
    filter.entityId = entityId;
  }
  const actorId = clean(input.actorId);
  if (actorId) {
    filter.actorId = actorId;
  }
  const actorType = clean(input.actorType);
  if (actorType) {
    if (!isActorType(actorType)) {
      throw validationError('actorType', `actorType must be one of: ${ACTOR_TYPES.join(', ')}`);
    }
    filter.actorType = actorType;
  }
  const action = clean(input.action);
  if (action) {
    filter.action = parseAuditAction(action);
  }
  const from = validDate(input.from, 'from');
  const to = validDate(input.to, 'to');
  if (from && to && from.getTime() > to.getTime()) {
    throw validationError('from', '"from" must not be after "to"');
  }
  if (from) {
    filter.from = from;
  }
  if (to) {
    filter.to = to;
  }
  return filter;
}
