import type { Page, PaginationQuery } from '@portal/schemas';
import { type CursorPosition, decodeCursor, encodeCursor } from './cursor';

/** What Prisma needs spliced into findMany to resume from a cursor. */
export interface PrismaCursorArgs {
  take: number;
  skip?: number;
  cursor?: { id: string };
}

/**
 * Asks for one row more than the page size. If it comes back, there is a next page —
 * which is one query instead of the count(*) that a total would cost on every request.
 */
export function cursorArgs(query: PaginationQuery): PrismaCursorArgs {
  const position: CursorPosition | undefined = query.cursor
    ? decodeCursor(query.cursor)
    : undefined;

  return {
    take: query.limit + 1,
    ...(position ? { cursor: { id: position.id }, skip: 1 } : {}),
  };
}

/**
 * Trims the probe row back off and mints the cursor for the next page.
 *
 *     const rows = await db.call.findMany({ ...cursorArgs(query), orderBy: { startedAt: 'desc' } });
 *     return toPage(rows, query, (row) => ({ id: row.id }));
 */
export function toPage<T extends { id: string | number }>(
  rows: T[],
  query: PaginationQuery,
  position: (row: T) => CursorPosition = (row) => ({ id: String(row.id) }),
): Page<T> {
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);

  return {
    items,
    next_cursor: hasMore && last ? encodeCursor(position(last)) : null,
  };
}
