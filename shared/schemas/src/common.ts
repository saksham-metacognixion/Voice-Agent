import { z } from 'zod';

/**
 * Cursor pagination per spec §16: ?cursor=&limit=.
 *
 * The cursor is opaque on purpose — it encodes a keyset position, so a client cannot
 * turn it into an offset and page past rows another workspace inserted.
 */
export const paginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

export interface Page<T> {
  items: T[];
  /** null when this is the last page. Pass it back as ?cursor= for the next one. */
  next_cursor: string | null;
  /**
   * Rows matching the filter across every page, when the list is cheap enough to count
   * (D2 asks for it so the pager can say "1–25 of 312"). Omitted where a count would cost
   * more than the page.
   */
  total?: number;
}

/** Long operations return 202 {job_id}; the client then listens on SSE (§16). */
export const acceptedJob = z.object({ job_id: z.string().uuid() });
export type AcceptedJob = z.infer<typeof acceptedJob>;

/** E.164 phone number, e.g. +14505550123 */
export const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164, e.g. +14505550123');

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });
