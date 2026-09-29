import * as Sentry from '@sentry/react';

/**
 * Browser error reporting for the portal and the console (D14, CLAUDE.md "Observability").
 * Off unless the app's `config.ts` hands it a DSN, so a dev box sends nothing.
 *
 * Errors only — no performance tracing, no replay, no session tracking. What never leaves
 * the browser: query strings and fragments (`/invite/?token=`, `/impersonate/#session=&key=`,
 * a recording link's `?token=` — an hour of customer reads), clicked-element text (a caller's
 * number in a table row), console output, request and response bodies, and user info.
 */

export interface ErrorReportingOptions {
  dsn: string;
  app: 'portal' | 'admin';
  environment: string;
  release?: string;
}

let on = false;

export function initErrorReporting(options: ErrorReportingOptions): boolean {
  if (on) return true;
  if (!options.dsn || typeof window === 'undefined') return false;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release || undefined,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    integrations: (defaults) => [
      ...defaults.filter((integration) => BROWSER_KEEP.has(integration.name)),
      Sentry.breadcrumbsIntegration({
        dom: false,
        fetch: true,
        history: true,
        xhr: true,
      }),
    ],
    initialScope: { tags: { app: options.app } },
    beforeSend: (event) => scrubBrowserEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
  on = true;
  return true;
}

/** For errors a component catches itself (an error boundary, a failed save it recovers from). */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  if (!on) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}

const BROWSER_KEEP = new Set([
  'EventFilters',
  'FunctionToString',
  'BrowserApiErrors',
  'GlobalHandlers',
  'LinkedErrors',
  'Dedupe',
  'HttpContext',
  'CultureContext',
]);

/** `https://app/x/?token=abc#key=1` → `https://app/x/`. Anything that is not a URL is returned as is. */
export function stripUrl(value: string): string {
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : value.slice(0, cut);
}

export function scrubBrowserEvent<E extends Sentry.ErrorEvent>(event: E): E {
  if (event.request) {
    if (event.request.url) event.request.url = stripUrl(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) {
      const { 'User-Agent': ua, 'user-agent': ua2 } = event.request.headers;
      event.request.headers = ua || ua2 ? { 'User-Agent': (ua || ua2) as string } : {};
    }
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  const data = breadcrumb.data;
  if (data) {
    for (const key of ['url', 'from', 'to']) {
      if (typeof data[key] === 'string') data[key] = stripUrl(data[key]);
    }
  }
  return breadcrumb;
}
