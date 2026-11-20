'use client';

import * as React from 'react';

/**
 * Previous/next over a §16 keyset list (`?cursor=&limit=` → `next_cursor`). The API only
 * hands out forward cursors, so the pager remembers the ones it walked to step back.
 * `reset()` returns to the first page — call it when a filter changes, since a cursor
 * is only meaningful for the filter that produced it.
 */
export function useCursorPager() {
  const [stack, setStack] = React.useState<Array<string | undefined>>([undefined]);
  const cursor = stack.at(-1);
  return {
    cursor,
    /** 1-based. */
    page: stack.length,
    hasPrevious: stack.length > 1,
    next: React.useCallback((nextCursor: string | null | undefined) => {
      if (nextCursor) setStack((s) => [...s, nextCursor]);
    }, []),
    previous: React.useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []),
    reset: React.useCallback(() => setStack([undefined]), []),
  };
}
