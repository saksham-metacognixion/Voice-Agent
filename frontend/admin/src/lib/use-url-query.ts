'use client';

import * as React from 'react';

/**
 * The page's query string as state, for a static export (copied from the portal, ADR 0018).
 *
 * `useSearchParams` needs a Suspense boundary in an exported app and `useRouter().push`
 * re-runs the whole route; this reads `window.location.search`, writes it back with the
 * History API (`push` for a change the person should be able to step back from, `replace`
 * for one they should not), and follows `popstate`, so back/forward, a refresh and a
 * pasted link all restore the same view.
 */
export function useUrlQuery(): [URLSearchParams, (update: (next: URLSearchParams) => void, mode?: 'push' | 'replace') => void] {
  const [params, setParams] = React.useState<URLSearchParams>(() => readLocationQuery());

  React.useEffect(() => {
    setParams(readLocationQuery());
    followHistory();
    const onChange = () => setParams((current) => (current.toString() === window.location.search.replace(/^\?/, '') ? current : readLocationQuery()));
    window.addEventListener('popstate', onChange);
    window.addEventListener(LOCATION_EVENT, onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(LOCATION_EVENT, onChange);
    };
  }, []);

  const set = React.useCallback((update: (next: URLSearchParams) => void, mode: 'push' | 'replace' = 'push') => {
    const next = new URLSearchParams(window.location.search);
    update(next);
    const query = next.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    if (mode === 'replace') window.history.replaceState(window.history.state, '', url);
    else window.history.pushState(window.history.state, '', url);
    setParams(next);
  }, []);

  return [params, set];
}

const LOCATION_EVENT = 'admin:locationchange';
let following = false;

/**
 * A Next `<Link>` to the page already on screen with another query is a `pushState` that
 * fires no `popstate` and does not remount the page. Wrapping the two History methods once
 * makes every such change an event this hook follows. Dispatched on a microtask, never
 * inline: Next calls these from a `useInsertionEffect`, where React refuses state updates.
 */
function followHistory(): void {
  if (following || typeof window === 'undefined') return;
  following = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      queueMicrotask(() => window.dispatchEvent(new Event(LOCATION_EVENT)));
    };
  }
}

function readLocationQuery(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

/** Sets or deletes one key; an empty, null or `undefined` value removes it. */
export function setParam(params: URLSearchParams, key: string, value: string | number | boolean | null | undefined): void {
  if (value === null || value === undefined || value === '' || value === false) params.delete(key);
  else params.set(key, String(value));
}

/** A query value narrowed to one of a list, else the fallback. */
export function pickParam<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T {
  const v = params.get(key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
