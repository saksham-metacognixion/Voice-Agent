import { z } from 'zod';

/** Cursor pagination per spec §16: ?cursor=&limit= */
export const paginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });

/** E.164 phone number, e.g. +14505550123 */
export const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164, e.g. +14505550123');

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });
