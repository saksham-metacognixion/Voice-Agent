import { Prisma } from '@prisma/client';

/** Postgres raises this from the append-only triggers on the three history tables. */
export const APPEND_ONLY_VIOLATION = 'append_only_violation';

export function isAppendOnlyViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    typeof error.meta?.message === 'string' &&
    error.meta.message.includes(APPEND_ONLY_VIOLATION)
  );
}

/**
 * True when a write was rejected by a row level security policy — i.e. code tried to
 * write into a workspace other than the one in context. Always a bug, never a 403 to
 * show a customer.
 */
export function isRlsViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    typeof error.meta?.message === 'string' &&
    error.meta.message.includes('row-level security')
  );
}

/**
 * Unique constraint violation, optionally on a specific constraint.
 *
 * Prisma only names the constraint when it recognises it from the schema. A violation of
 * a hand-written index (the partial index on credit_ledger) or one raised inside an
 * interactive transaction often arrives as `target: "(not available)"`. When the target
 * is unknown the answer is "a unique violation, constraint unknown" — callers that insert
 * into a table with exactly one candidate unique key (webhook_events, the call debit) treat
 * that as a hit; see isDuplicateWebhook / isDuplicateCallDebit.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!constraint) return true;
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.includes(constraint)
    : String(target ?? '').includes(constraint);
}

/** True when Prisma could not tell which unique constraint was hit. */
export function uniqueTargetUnknown(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
  return target === undefined || target === null || (typeof target === 'string' && /not available/i.test(target));
}

/** The ledger's one-debit-per-call guard (§14.2). A replayed call_ended lands here. */
export const CALL_DEBIT_ONCE_CONSTRAINT = 'credit_ledger_call_debit_once_idx';

export function isDuplicateCallDebit(error: unknown): boolean {
  // credit_ledger has one unique index besides its uuid PK, so an unnamed P2002 on a
  // ledger insert can only be this one.
  return isUniqueViolation(error, CALL_DEBIT_ONCE_CONSTRAINT) || isUniqueViolation(error, 'ref_id') || uniqueTargetUnknown(error);
}

/** The webhook exactly-once guard (§13.10). A duplicate insert answers 204. */
export const WEBHOOK_DEDUPE_CONSTRAINT = 'webhook_events_provider_external_id_event_type_key';

export function isDuplicateWebhook(error: unknown): boolean {
  // webhook_events has one unique key besides its uuid PK — same reasoning as above.
  return (
    isUniqueViolation(error, WEBHOOK_DEDUPE_CONSTRAINT) ||
    isUniqueViolation(error, 'provider') ||
    isUniqueViolation(error, 'external_id') ||
    uniqueTargetUnknown(error)
  );
}
