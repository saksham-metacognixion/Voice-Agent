'use client';

import * as React from 'react';

/**
 * Asks before unsaved work is thrown away by leaving the page — a reload, closing the
 * tab, or following a link to another screen (the sidebar, the tab bar, "Back to
 * agents"). `beforeunload` only covers the first two: an App Router link is a
 * client-side navigation that never unloads the document, so a click on a same-origin
 * link to another path is caught in the capture phase, before React and `next/link`
 * see it, and dropped unless the person confirms (QA-024).
 *
 * A link to the same path (a `?tab=` change) keeps the page mounted, so it is let
 * through. The browser's own back button is not covered: the App Router exposes no
 * hook to veto a `popstate`.
 */
export function useLeaveGuard(dirty: boolean, message: string): void {
  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome before 119 needs a value; the text itself is never shown.
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      if (!leavesPage(e, window.location)) return;
      if (window.confirm(message)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, message]);
}

/** True for a plain click on a same-origin link to another path, opened in this tab. */
export function leavesPage(e: Pick<MouseEvent, 'defaultPrevented' | 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'target'>, here: Pick<Location, 'href' | 'origin' | 'pathname'>): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const target = e.target as { closest?: (selector: string) => unknown } | null;
  const anchor = target?.closest?.('a[href]') as { href: string; target?: string; hasAttribute?: (name: string) => boolean } | null | undefined;
  if (!anchor) return false;
  if (anchor.target && anchor.target !== '_self') return false; // a new tab keeps this one
  if (anchor.hasAttribute?.('download')) return false;
  let url: URL;
  try {
    url = new URL(anchor.href, here.href);
  } catch {
    return false;
  }
  // Another site unloads the document, which `beforeunload` already asks about.
  if (url.origin !== here.origin) return false;
  return url.pathname !== here.pathname;
}
