import type { CaptureResult } from 'posthog-js';

/**
 * What PostHog may learn from a URL (QA-008). The portal's query strings and fragments
 * carry credentials: `/?code=&state=` on the Auth0 return, `/invite/?token=`,
 * `/impersonate/#session=&key=`, W7's `?session_id=` back from Stripe, `?next=` holding
 * any of those. So every URL leaves with its path only, plus the few parameters below,
 * which name a screen and never a person or a secret.
 *
 * Applied in `before_send`, so it covers every capture — the hand-made `$pageview`, the
 * SDK's own `$pageleave`, `track()` events and anything the SDK adds later — and the
 * person properties (`$set`, `$set_once`: `$initial_current_url`, `$initial_referrer`…).
 */
const ALLOWED_PARAMS = new Set(['tab']);

/** Property names that hold a URL, matched case-insensitively. */
const URL_KEY = /(url|href|referrer|referer|pathname|location)$/i;

/**
 * Property names that are a credential or a one-time value whatever their contents. Not
 * `token`: the SDK sends the project key as `properties.token` and an event without it
 * is refused by ingestion. Nothing of ours is named like these (`track()` sends ids,
 * step names and counts), so dropping them can only remove a mistake.
 */
const SECRET_KEY = /^(code|state|invite_token|access_token|id_token|refresh_token|session_id|checkout_session_id|live_token|password|secret)$/i;

const BASE = 'https://portal.invalid';

function ownOrigin(): string | null {
  return typeof window !== 'undefined' && window.location ? window.location.origin : null;
}

/**
 * `https://app.example/invite/?token=X#y` → `https://app.example/invite/`; a bare path
 * keeps no origin. Another site's URL — a referrer from Universal Login or Stripe
 * Checkout, whose path is `/c/pay/cs_…` — keeps only its origin: its path is not ours
 * to vouch for.
 */
export function sanitizeUrl(value: string, origin: string | null = ownOrigin()): string {
  const trimmed = value.trim();
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith('//');
  // Not a URL or a path (`$direct`, a bare domain): only ever lose a query or fragment.
  if (!absolute && !trimmed.startsWith('/')) return trimmed.split(/[?#]/, 1)[0] ?? '';
  let url: URL;
  try {
    url = new URL(trimmed, BASE);
  } catch {
    // Unparseable: keep what precedes any query or fragment, nothing after.
    return trimmed.split(/[?#]/, 1)[0] ?? '';
  }
  const kept = new URLSearchParams();
  url.searchParams.forEach((v, k) => {
    if (ALLOWED_PARAMS.has(k)) kept.set(k, v);
  });
  if (absolute && origin && url.origin !== origin) return `${url.origin}/`;
  const query = kept.toString();
  return `${absolute ? url.origin : ''}${url.pathname}${query ? `?${query}` : ''}`;
}

function looksLikeUrl(value: string): boolean {
  return /^(https?:)?\/\//i.test(value) || (value.startsWith('/') && /[?#]/.test(value));
}

function clean(value: unknown, key: string, depth: number): unknown {
  if (typeof value === 'string') return URL_KEY.test(key) || looksLikeUrl(value) ? sanitizeUrl(value) : value;
  // Nested bags too: web vitals carry their own `$current_url` one level down.
  if (depth >= 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, key, depth + 1));
  return cleanBag(value as Record<string, unknown>, depth + 1);
}

function cleanBag(props: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = clean(value, key, depth);
  }
  return out;
}

/** One property bag: URL-shaped values stripped, credential-named keys dropped. */
export function sanitizeProperties<T extends Record<string, unknown> | undefined>(props: T): T {
  if (!props) return props;
  return cleanBag(props, 0) as T;
}

/** The `before_send` hook. Never drops an event; only what it carries. */
export function sanitizeCapture(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  return {
    ...event,
    properties: sanitizeProperties(event.properties),
    ...(event.$set ? { $set: sanitizeProperties(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: sanitizeProperties(event.$set_once) } : {}),
  };
}
