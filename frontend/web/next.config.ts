import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

/**
 * Static export to S3 + CloudFront (ADR 0008): no server, no route handlers, every page a
 * file. `trailingSlash` makes `/onboarding/brief` land at `/onboarding/brief/index.html`,
 * which is what the CloudFront function rewrites to.
 *
 * `NEXT_PUBLIC_*` is baked in at build time, so staging and production are separate builds.
 * Locally the values come from the repo-root `.env` (one file for every package): the
 * frontend names are derived from the backend ones when the public ones are unset, so a
 * dev box needs nothing extra.
 */
const rootEnv = loadRootEnv();
const pick = (name: string, ...fallbacks: string[]): string | undefined => {
  for (const key of [name, ...fallbacks]) {
    const v = process.env[key] ?? rootEnv[key];
    if (v) return v;
  }
  return undefined;
};

const publicEnv: Record<string, string> = {};
const set = (key: string, value: string | undefined) => {
  if (value !== undefined) publicEnv[key] = value;
};
set('NEXT_PUBLIC_API_URL', pick('NEXT_PUBLIC_API_URL') ?? `http://localhost:${pick('API_PORT') ?? '4000'}`);
set('NEXT_PUBLIC_AUTH0_DOMAIN', pick('NEXT_PUBLIC_AUTH0_DOMAIN', 'AUTH0_DOMAIN', 'AUTH0_CUSTOMER_DOMAIN'));
set('NEXT_PUBLIC_AUTH0_CLIENT_ID', pick('NEXT_PUBLIC_AUTH0_CLIENT_ID', 'AUTH0_CLIENT_ID'));
set('NEXT_PUBLIC_AUTH0_AUDIENCE', pick('NEXT_PUBLIC_AUTH0_AUDIENCE', 'AUTH0_AUDIENCE', 'AUTH0_CUSTOMER_AUDIENCE'));
set('NEXT_PUBLIC_POSTHOG_KEY', pick('NEXT_PUBLIC_POSTHOG_KEY'));
set('NEXT_PUBLIC_POSTHOG_HOST', pick('NEXT_PUBLIC_POSTHOG_HOST'));
set('NEXT_PUBLIC_APP_ENV', pick('NEXT_PUBLIC_APP_ENV', 'APP_ENV') ?? 'dev');
set('NEXT_PUBLIC_SUPPORT_EMAIL', pick('NEXT_PUBLIC_SUPPORT_EMAIL'));
set('NEXT_PUBLIC_STATUS_PAGE_URL', pick('NEXT_PUBLIC_STATUS_PAGE_URL'));

const nextConfig: NextConfig = {
  /**
   * The dev server gets its own build directory.
   *
   * `next dev` keeps `.next` alive and watched, and `next build` rewrites the same
   * directory from scratch — including `static/development/_buildManifest.js` and the
   * per-route `app-paths-manifest.json` the running server holds open. One `pnpm build`,
   * `pnpm typecheck` (the web typecheck task depends on `build`) or `deploy-frontend.sh`
   * in a second terminal and the dev server starts throwing `ENOENT … _buildManifest.js
   * .tmp.…` on every compile until it is restarted.
   *
   * So `pnpm dev` sets `NEXT_DIST_DIR=.next-dev` and nothing else does: builds still write
   * `.next` exactly as before (CI, the export and `tsconfig`'s `.next/types` all depend on
   * that), and the two can now run at the same time.
   */
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@portal/ui', '@portal/api-client', '@portal/schemas'],
  poweredByHeader: false,
  env: publicEnv,
};

export default nextConfig;

function loadRootEnv(): Record<string, string> {
  // frontend/web → repo root is two levels up. Only read; nothing here is written back.
  const file = resolve(process.cwd(), '..', '..', '.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.search(/\s#/);
    if (hash >= 0) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}
