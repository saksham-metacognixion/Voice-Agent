import { AppError } from '../errors/app-error';

/**
 * Opaque keyset cursors for ?cursor=&limit= (§16).
 *
 * Keyset, not offset: the cursor names the last row of the previous page, so inserts
 * and deletes between requests never duplicate or skip a row — which matters when the
 * list is a call log that grows while the customer reads it.
 *
 * Opaque because a decodable cursor invites clients to forge one. It is still only
 * base64 — the actual protection is that RLS scopes the query either way.
 */
const VERSION = 1;

export interface CursorPosition {
  /** Primary key of the last row on the previous page. */
  id: string;
  /** Tiebreaker for the sort column, ISO 8601, when the list is not sorted by id. */
  sortedAt?: string;
}

export function encodeCursor(position: CursorPosition): string {
  const payload = JSON.stringify([VERSION, position.id, position.sortedAt ?? null]);
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalidCursor();
  const [version, id, sortedAt] = parsed as [unknown, unknown, unknown];
  if (version !== VERSION || typeof id !== 'string' || id.length === 0) throw invalidCursor();
  if (sortedAt !== null && typeof sortedAt !== 'string') throw invalidCursor();

  return { id, ...(sortedAt ? { sortedAt } : {}) };
}

export function invalidCursor(): AppError {
  return new AppError(
    'INVALID_CURSOR',
    'That page link is no longer valid. Start from the first page.',
  );
}
