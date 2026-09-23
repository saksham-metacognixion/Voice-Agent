import * as React from 'react';

/** A stable callback that fires `ms` after the last call; `flush()` runs it now, `cancel()` drops it. */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<A | null>(null);

  const cancel = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      const args = pending.current;
      pending.current = null;
      fnRef.current(...args);
    }
  }, []);

  const call = React.useCallback(
    (...args: A) => {
      pending.current = args;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const a = pending.current;
        pending.current = null;
        if (a) fnRef.current(...a);
      }, ms);
    },
    [ms],
  );

  React.useEffect(() => cancel, [cancel]);
  return { call, flush, cancel, isPending: () => pending.current !== null };
}
