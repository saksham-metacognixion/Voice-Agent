/**
 * Build-time configuration. Every value is `NEXT_PUBLIC_*`, inlined by Next at build (ADR
 * 0008) — nothing secret can live here, and a wrong value is a rebuild, not a restart.
 * `next.config.ts` derives the local values from the repo-root `.env`.
 */
export const config = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
  auth0: {
    domain: process.env.NEXT_PUBLIC_AUTH0_DOMAIN ?? '',
    clientId: process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID ?? '',
    audience: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE ?? '',
  },
  posthog: {
    key: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
  },
  appEnv: process.env.NEXT_PUBLIC_APP_ENV ?? 'dev',
  /** D14: browser errors to Sentry. Empty = off (a dev box sends nothing). */
  sentry: {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
    release: process.env.NEXT_PUBLIC_RELEASE ?? '',
  },
  support: {
    /** D7 contact. The address the portal already gave people before D11. */
    email: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@oraly.ai',
    /**
     * D7 status page. Optional: no vendor is chosen yet (§20 item 10), so without it the
     * Help page shows only the API's own readiness.
     */
    statusPageUrl: safeHttpsUrl(process.env.NEXT_PUBLIC_STATUS_PAGE_URL),
  },
} as const;

/** An `https:` URL, or '' — a build-time value that is not one is dropped rather than linked. */
function safeHttpsUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

export const authConfigured = Boolean(config.auth0.domain && config.auth0.clientId && config.auth0.audience);

/** What is missing, for the one-line banner on a misconfigured box. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.auth0.domain) missing.push('NEXT_PUBLIC_AUTH0_DOMAIN');
  if (!config.auth0.clientId) missing.push('NEXT_PUBLIC_AUTH0_CLIENT_ID');
  if (!config.auth0.audience) missing.push('NEXT_PUBLIC_AUTH0_AUDIENCE');
  return missing;
}
