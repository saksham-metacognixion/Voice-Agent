import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { cursorArgs, decodeCursor, encodeCursor, toPage } from './index';

const query = (over: Partial<{ cursor: string; limit: number }> = {}) => ({
  limit: 25,
  ...over,
});

describe('cursors', () => {
  it('round-trips a position', () => {
    const position = { id: 'call_abc', sortedAt: '2026-09-14T10:00:00.000Z' };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('round-trips a position with no sort tiebreaker', () => {
    expect(decodeCursor(encodeCursor({ id: 'ag_1' }))).toEqual({ id: 'ag_1' });
  });

  it('is opaque — no id leaks into the string itself', () => {
    expect(encodeCursor({ id: 'call_abc' })).not.toContain('call_abc');
  });

  it.each([
    ['not base64', '!!!!'],
    ['valid base64, wrong shape', Buffer.from('{"id":"x"}').toString('base64url')],
    ['an older cursor version', Buffer.from('[0,"x",null]').toString('base64url')],
    ['an empty id', Buffer.from('[1,"",null]').toString('base64url')],
  ])('rejects %s with INVALID_CURSOR rather than a 500', (_label, cursor) => {
    try {
      decodeCursor(cursor);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_CURSOR');
      expect((error as AppError).getStatus()).toBe(400);
    }
  });
});

describe('cursorArgs', () => {
  it('asks for one row beyond the page, so "is there more" costs no extra query', () => {
    expect(cursorArgs(query({ limit: 10 }))).toEqual({ take: 11 });
  });

  it('resumes after the cursor row rather than including it again', () => {
    const args = cursorArgs(query({ limit: 10, cursor: encodeCursor({ id: 'row_5' }) }));
    expect(args).toEqual({ take: 11, cursor: { id: 'row_5' }, skip: 1 });
  });
});

describe('toPage', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `row_${i}` }));

  it('drops the probe row and hands back a cursor when there is more', () => {
    const page = toPage(rows(4), query({ limit: 3 }));
    expect(page.items.map((r) => r.id)).toEqual(['row_0', 'row_1', 'row_2']);
    expect(page.next_cursor).not.toBeNull();
    expect(decodeCursor(page.next_cursor!)).toEqual({ id: 'row_2' });
  });

  it('returns a null cursor on the last page', () => {
    const page = toPage(rows(2), query({ limit: 3 }));
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  it('returns a null cursor on an empty page', () => {
    expect(toPage([], query({ limit: 3 }))).toEqual({ items: [], next_cursor: null });
  });

  it('handles an exactly-full page without claiming there is more', () => {
    expect(toPage(rows(3), query({ limit: 3 })).next_cursor).toBeNull();
  });

  it('walks a list end to end without repeating or skipping a row', () => {
    const all = rows(7);
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 10; guard += 1) {
      const q = query({ limit: 3, ...(cursor ? { cursor } : {}) });
      const args = cursorArgs(q);
      const start = args.cursor ? all.findIndex((r) => r.id === args.cursor!.id) + 1 : 0;
      const page = toPage(all.slice(start, start + args.take), q);

      seen.push(...page.items.map((r) => r.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }

    expect(seen).toEqual(all.map((r) => r.id));
  });

  it('accepts a custom position for lists not keyed by id alone', () => {
    const page = toPage(
      [
        { id: 'a', startedAt: '2026-09-14T10:00:00.000Z' },
        { id: 'b', startedAt: '2026-09-14T09:00:00.000Z' },
      ],
      query({ limit: 1 }),
      (row) => ({ id: row.id, sortedAt: row.startedAt }),
    );
    expect(decodeCursor(page.next_cursor!)).toEqual({
      id: 'a',
      sortedAt: '2026-09-14T10:00:00.000Z',
    });
  });
});
