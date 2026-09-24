'use client';

import * as React from 'react';

/**
 * The page's query string as state, for a static export.
 *
 * `useSearchParams` needs a Suspense boundary in an exported app and `useRouter().push`
 * re-runs the whole route; this reads `window.location.search`, writes it back with the
 * History API (`push` for a change the person should be able to step back from — a
 * filter, a page — and `replace` for one they should not, like opening a drawer twice),
 * and follows `popstate`, so the back and forward buttons, a refresh and a pasted link
 * all restore the same view. Every component on the page reads the same store, so
 * there is one filter state, in the URL, never two.
 */
export function useUrlQuery(): [URLSearchParams, (update: (next: URLSearchParams) => void, mode?: 'push' | 'replace') => void] {
  const [params, setParams] = React.useState<URLSearchParams>(() => readLocationQuery());

  React.useEffect(() => {
    // The first render on an export happens before `window.location` reflects the
    // link (and on the server, with none at all): read again once mounted.
    setParams(readLocationQuery());
    const onPop = () => setParams(readLocationQuery());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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

function readLocationQuery(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

/** Sets or deletes one key; an empty, null or `undefined` value removes it. */
export function setParam(params: URLSearchParams, key: string, value: string | number | boolean | null | undefined): void {
  if (value === null || value === undefined || value === '' || value === false) params.delete(key);
  else params.set(key, String(value));
}
