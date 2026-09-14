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

/** Unique constraint violation, optionally on a specific constraint. */
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

/** The ledger's one-debit-per-call guard (§14.2). A replayed call_ended lands here. */
export const CALL_DEBIT_ONCE_CONSTRAINT = 'credit_ledger_call_debit_once_idx';

export function isDuplicateCallDebit(error: unknown): boolean {
  return isUniqueViolation(error, CALL_DEBIT_ONCE_CONSTRAINT);
}

/** The webhook exactly-once guard (§13.10). A duplicate insert answers 204. */
export const WEBHOOK_DEDUPE_CONSTRAINT = 'webhook_events_provider_external_id_event_type_key';

export function isDuplicateWebhook(error: unknown): boolean {
  return (
    isUniqueViolation(error, WEBHOOK_DEDUPE_CONSTRAINT) ||
    isUniqueViolation(error, 'provider') ||
    isUniqueViolation(error, 'external_id')
  );
}
