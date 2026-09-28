/**
 * Build-time configuration. Every value is `NEXT_PUBLIC_*`, inlined by Next at build (ADR
 * 0008) — nothing secret can live here, and a wrong value is a rebuild, not a restart.
 * `next.config.ts` derives the local values from the repo-root `.env` (staff names).
 * This is the only file that reads `process.env`.
 */
export const config = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
  auth0: {
    domain: process.env.NEXT_PUBLIC_AUTH0_DOMAIN ?? '',
    clientId: process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID ?? '',
    audience: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE ?? '',
  },
  /** The customer portal origin, for "Open portal" on an impersonation banner. */
  portalUrl: (process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  appEnv: process.env.NEXT_PUBLIC_APP_ENV ?? 'dev',
} as const;

export const authConfigured = Boolean(config.auth0.domain && config.auth0.clientId && config.auth0.audience);

/** What is missing, for the one-line banner on a misconfigured box. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.auth0.domain) missing.push('NEXT_PUBLIC_AUTH0_DOMAIN');
  if (!config.auth0.clientId) missing.push('NEXT_PUBLIC_AUTH0_CLIENT_ID');
  if (!config.auth0.audience) missing.push('NEXT_PUBLIC_AUTH0_AUDIENCE');
  return missing;
}
