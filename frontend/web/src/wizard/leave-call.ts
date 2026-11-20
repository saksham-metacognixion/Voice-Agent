/**
 * §12.3 step 4: "stopCall() on End button or route change (prompt 'End your test call?')".
 *
 * While a test call is live the page must not be left by accident. Three doors lead out:
 * a link (the stepper, Back, the sidebar), the browser's own navigation (reload, close,
 * the back button) and a button that calls the router (W5's Continue). This module is
 * the one place that knows a call is live, so all three can ask the same question.
 *
 *   `activeCall.set(on, hangUp)`  — the test-call panel reports its state
 *   `guardNavigation(proceed)`    — a button that navigates asks first; `proceed` runs
 *                                   at once when no call is live, else after "Leave"
 *   `LeaveCallPrompt`             — mounted by the panel: the dialog, the link and
 *                                   history interception, the `beforeunload` guard
 *
 * The decision of *which* click to intercept is `interceptsNavigation`, pure, so it can
 * be tested without a browser: same-document links (`#`, the current page), new-tab
 * links, modifier clicks and `mailto:`/`tel:` never open the prompt.
 */
export interface ActiveCallState {
  live: boolean;
  /** Hangs up the live call; resolves once the hang-up was asked for. */
  hangUp: () => void;
}

type Listener = () => void;

let state: ActiveCallState = { live: false, hangUp: () => undefined };
let pending: { proceed: () => void } | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const activeCall = {
  get: (): ActiveCallState => state,
  set(live: boolean, hangUp: () => void) {
    if (state.live === live && state.hangUp === hangUp) return;
    state = { live, hangUp };
    if (!live) pending = null;
    emit();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** The navigation waiting on an answer, if any. */
export const leaveRequest = {
  get: () => pending,
  subscribe: activeCall.subscribe,
  /** "Stay": forget the navigation. */
  stay() {
    pending = null;
    emit();
  },
  /** "Leave": hang up, then go. */
  leave() {
    const p = pending;
    pending = null;
    state.hangUp();
    emit();
    p?.proceed();
  },
};

/**
 * Runs `proceed` now when no call is live, else parks it behind the prompt. Returns
 * whether it ran. Used by buttons that navigate through the router.
 */
export function guardNavigation(proceed: () => void): boolean {
  if (!state.live) {
    proceed();
    return true;
  }
  pending = { proceed };
  emit();
  return false;
}

export interface ClickFacts {
  href: string | null;
  target: string | null;
  download: boolean;
  /** ctrl / meta / shift / alt, or a non-primary button: the browser opens elsewhere, the page stays. */
  modified: boolean;
  defaultPrevented: boolean;
}

/**
 * Whether a click on an anchor would leave this document. Only then is the prompt worth
 * showing; everything else is left to the browser.
 */
export function interceptsNavigation(click: ClickFacts, current: { href: string; origin: string }): boolean {
  if (click.defaultPrevented || click.modified || click.download) return false;
  if (!click.href) return false;
  if (click.target && click.target !== '_self') return false;
  let url: URL;
  try {
    url = new URL(click.href, current.href);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== current.origin) return true;
  const here = new URL(current.href);
  // The same page with only the fragment changed scrolls; nothing is torn down.
  return !(url.pathname === here.pathname && url.search === here.search);
}

/** Reads the facts of a click off the DOM event, for `interceptsNavigation`. Null when the click was not on a link. */
export function clickFacts(event: MouseEvent): ClickFacts | null {
  const target = event.target as Element | null;
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return null;
  return {
    href: anchor.getAttribute('href'),
    target: anchor.getAttribute('target'),
    download: anchor.hasAttribute('download'),
    modified: event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
    defaultPrevented: event.defaultPrevented,
  };
}
