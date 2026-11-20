import { Logger } from '@nestjs/common';
import { resolveAppEnv } from './app-env';

const DEV_PORTAL_URL = 'http://localhost:3000';
let warned = false;

/**
 * The customer portal's origin, normalised (no trailing slash). Every customer email and
 * every Stripe return URL is built from it, and `deploy.sh` refuses a box without it — so
 * the code must not quietly undo that guard with five private `?? 'http://localhost:3000'`
 * fallbacks. This is the one fallback: fine in dev, ci and tests, logged once as an error
 * in staging and prod, and refused outright at boot by `assertPortalUrl()`.
 */
export function portalUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PORTAL_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  const appEnv = resolveAppEnv(env);
  if ((appEnv === 'staging' || appEnv === 'prod') && !warned) {
    warned = true;
    new Logger('PortalUrl').error(`PORTAL_URL is not set in ${appEnv}; links will point at ${DEV_PORTAL_URL}`);
  }
  return DEV_PORTAL_URL;
}

/** Boot check for the API and the worker: staging and prod do not start without a real PORTAL_URL. */
export function assertPortalUrl(env: NodeJS.ProcessEnv = process.env): void {
  const appEnv = resolveAppEnv(env);
  if (appEnv !== 'staging' && appEnv !== 'prod') return;
  const raw = env.PORTAL_URL?.trim() ?? '';
  if (!raw || /localhost|127\.0\.0\.1/.test(raw)) {
    throw new Error(`PORTAL_URL must be the portal's public origin in ${appEnv} (got ${raw ? JSON.stringify(raw) : 'nothing'}); customer emails and Stripe return URLs are built from it`);
  }
}
