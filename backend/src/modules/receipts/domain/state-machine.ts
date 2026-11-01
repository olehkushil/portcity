/**
 * Receipt state machine (brief section 6):
 *
 *   uploaded -> parsed -> auto_approved -> credited
 *                      \-> needs_moderation -> approved -> credited
 *                                           \-> rejected(reason) -> appealed -> needs_moderation
 *                      \-> rejected (rule rejection: too old, future, excluded tenant, bad total)
 *   auto_approved -> needs_moderation (system: the daily QR points cap was reached by a
 *                                      concurrent receipt, re-checked under the member lock)
 *   credited -> rejected (system: the tax checker rejected the receipt during its verification
 *                         hold; the pending points are reversed in the same transaction)
 *
 * Pure module: no Nest, no Prisma.
 */
import type { ReceiptStatus } from '../../../common/contracts/receipts';
import type { ActorType } from '../../../common/contracts/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { ReceiptErrors } from './errors';

export interface ReceiptTransition {
  from: ReceiptStatus;
  to: ReceiptStatus;
  /** Who may trigger the transition. */
  actors: readonly ActorType[];
}

export const RECEIPT_TRANSITIONS: readonly ReceiptTransition[] = Object.freeze([
  { from: 'uploaded', to: 'parsed', actors: ['system'] },
  { from: 'parsed', to: 'auto_approved', actors: ['system'] },
  { from: 'parsed', to: 'needs_moderation', actors: ['system'] },
  { from: 'parsed', to: 'rejected', actors: ['system'] },
  { from: 'auto_approved', to: 'credited', actors: ['system'] },
  { from: 'auto_approved', to: 'needs_moderation', actors: ['system'] },
  { from: 'needs_moderation', to: 'approved', actors: ['admin'] },
  { from: 'needs_moderation', to: 'rejected', actors: ['admin'] },
  { from: 'approved', to: 'credited', actors: ['system'] },
  { from: 'credited', to: 'rejected', actors: ['system'] },
  { from: 'rejected', to: 'appealed', actors: ['user'] },
  { from: 'appealed', to: 'needs_moderation', actors: ['admin', 'system'] },
]);

/**
 * Nothing a member or a moderator can do moves a receipt out of these statuses (the system may
 * still reverse a credited receipt whose verification failed during the hold).
 */
export const FINAL_RECEIPT_STATUSES: readonly ReceiptStatus[] = Object.freeze(['credited']);

/** Statuses a moderator works on. */
export const MODERATION_QUEUE_STATUSES: readonly ReceiptStatus[] = Object.freeze([
  'needs_moderation',
  'appealed',
]);

/** Statuses the worker may still move forward (after a decision or an approval). */
export const CREDITABLE_STATUSES: readonly ReceiptStatus[] = Object.freeze([
  'auto_approved',
  'approved',
]);

export function canTransition(from: ReceiptStatus, to: ReceiptStatus, actor?: ActorType): boolean {
  return RECEIPT_TRANSITIONS.some(
    (transition) =>
      transition.from === from &&
      transition.to === to &&
      (actor === undefined || transition.actors.includes(actor)),
  );
}

export function nextStatuses(from: ReceiptStatus, actor?: ActorType): ReceiptStatus[] {
  return RECEIPT_TRANSITIONS.filter(
    (transition) =>
      transition.from === from && (actor === undefined || transition.actors.includes(actor)),
  ).map((transition) => transition.to);
}

export function isFinalStatus(status: ReceiptStatus): boolean {
  return FINAL_RECEIPT_STATUSES.includes(status);
}

export function isCreditable(status: ReceiptStatus): boolean {
  return CREDITABLE_STATUSES.includes(status);
}

/** A member may appeal only a rejected receipt. */
export function canAppeal(status: ReceiptStatus): boolean {
  return canTransition(status, 'appealed', 'user');
}

/** The moderator's decision on an appealed receipt is final: one appeal per receipt. */
export const MAX_APPEALS_PER_RECEIPT = 1;

/** canAppeal() plus the per-receipt appeal limit. */
export function canAppealWith(status: ReceiptStatus, appealsSoFar: number): boolean {
  return canAppeal(status) && appealsSoFar < MAX_APPEALS_PER_RECEIPT;
}

/** Throws PC_RECEIPT_INVALID_TRANSITION (409) when the move is not allowed for the actor. */
export function assertTransition(from: ReceiptStatus, to: ReceiptStatus, actor: ActorType): void {
  if (!canTransition(from, to, actor)) {
    throw new DomainError(
      ReceiptErrors.PC_RECEIPT_INVALID_TRANSITION,
      `Receipt cannot move from "${from}" to "${to}" (${actor})`,
      { details: { from, to, actor, allowed: nextStatuses(from, actor) } },
    );
  }
}
