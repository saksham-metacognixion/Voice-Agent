import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

/**
 * Static export to S3 + CloudFront (ADR 0008), exactly like the portal: no server, no
 * dynamic segments, every page a file. Detail pages are `/section/detail/?id=`.
 *
 * `NEXT_PUBLIC_*` is baked in at build time. Locally the values come from the repo-root
 * `.env`, derived from the STAFF names (`ADMIN_AUTH0_*` / `AUTH0_STAFF_*`), so a dev box
 * needs nothing extra. Nothing outside `src/config.ts` reads `process.env`.
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
set('NEXT_PUBLIC_AUTH0_DOMAIN', pick('NEXT_PUBLIC_AUTH0_DOMAIN', 'ADMIN_AUTH0_DOMAIN', 'AUTH0_STAFF_DOMAIN'));
set('NEXT_PUBLIC_AUTH0_CLIENT_ID', pick('NEXT_PUBLIC_AUTH0_CLIENT_ID', 'ADMIN_AUTH0_CLIENT_ID'));
set('NEXT_PUBLIC_AUTH0_AUDIENCE', pick('NEXT_PUBLIC_AUTH0_AUDIENCE', 'ADMIN_AUTH0_AUDIENCE', 'AUTH0_STAFF_AUDIENCE'));
set('NEXT_PUBLIC_PORTAL_URL', pick('NEXT_PUBLIC_PORTAL_URL', 'PORTAL_URL') ?? 'http://localhost:3000');
set('NEXT_PUBLIC_APP_ENV', pick('NEXT_PUBLIC_APP_ENV', 'APP_ENV') ?? 'dev');

const nextConfig: NextConfig = {
  /**
   * The dev server gets its own build directory, for the reason written out in the
   * portal's config: `next dev` and `next build` cannot share `.next` without the running
   * server losing the manifests it holds open. `pnpm dev` sets `NEXT_DIST_DIR=.next-dev`;
   * builds and CI keep writing `.next`.
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
  // frontend/admin → repo root is two levels up. Only read; nothing here is written back.
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
