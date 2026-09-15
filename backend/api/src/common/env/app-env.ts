import { Logger } from '@nestjs/common';

/**
 * `APP_ENV` is a gate, not a label: it decides whether the unauthenticated dev routes
 * exist, whether webhook fixtures are written to disk, and whether Retell objects are
 * named `dev-…`. So it is resolved **fail-closed** — an unset or unrecognised value is
 * treated as `prod`, the most restrictive answer, rather than as `dev`.
 *
 * The earlier `process.env.APP_ENV ?? 'dev'` inverted that: nothing in `infra/` sets
 * APP_ENV, so a container that dropped it would have exposed the dev token minter on
 * `api.<domain>` and skipped the https check on `API_PUBLIC_URL`. `pnpm doctor` fails
 * while APP_ENV is unset, so a correct deployment never lands here.
 */
export const APP_ENVS = ['dev', 'ci', 'staging', 'prod'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const logger = new Logger('AppEnv');
const warned = new Set<string>();

export function resolveAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const raw = env.APP_ENV?.trim();
  if (!raw) return warnOnce('unset', 'APP_ENV is not set; assuming prod. Set it to dev | ci | staging | prod (.env.example).');
  if (raw === 'production') return 'prod';
  if ((APP_ENVS as readonly string[]).includes(raw)) return raw as AppEnv;
  return warnOnce(raw, `APP_ENV="${raw}" is not one of ${APP_ENVS.join(' | ')}; assuming prod.`);
}

/** True only when APP_ENV is explicitly `dev`. Guards everything that must not exist elsewhere. */
export function isDevEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAppEnv(env) === 'dev';
}

/** True for prod *and* for anything unrecognised. Never assume a non-prod default. */
export function isProdEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAppEnv(env) === 'prod';
}

function warnOnce(key: string, message: string): 'prod' {
  if (!warned.has(key)) {
    warned.add(key);
    logger.warn(message);
  }
  return 'prod';
}
