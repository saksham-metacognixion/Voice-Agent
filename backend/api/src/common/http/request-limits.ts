import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ERROR_STATUS } from '@portal/schemas';
import { portalUrl } from '../env';
import { clientBucket } from './client-bucket';

/**
 * §6.2 "CSRF: … origin check on state-changing requests" and the API-wide request budget,
 * as one Fastify `onRequest` hook — before routing, before the body is parsed, before a
 * JWT is verified, so a flood costs one Redis INCR per request and never a 32 MiB parse.
 *
 * **Origin.** Auth is a bearer token in a header (ADR 0008 — no cookie), so a forged
 * cross-site request carries no credential and CSRF in the classic sense cannot happen.
 * The check is the second fence the spec asks for: a POST/PUT/PATCH/DELETE that names an
 * `Origin` other than the portal's or the console's is refused with 403
 * `ORIGIN_NOT_ALLOWED`. A request with no `Origin` (a server, curl, a provider) is not a
 * browser acting for someone and is left to authentication.
 *
 * **Budget.** A fixed one-minute window per client IP (`API_RATE_LIMIT_PER_MIN`, default
 * 600, 0 turns it off) answers 429 `RATE_LIMITED` with `Retry-After`. `request.ip` is the
 * real client: Caddy trusts `X-Forwarded-For` only from private ranges and replaces it on
 * every public request, so the header cannot be rotated to dodge the window. An IPv6
 * client is counted by its /64 (`clientBucket`), which a host can rotate through freely. Redis silent
 * or slow past 50 ms = allow (the cache never throws); a budget that fails closed would
 * turn a Redis blip into an outage of the whole portal.
 *
 * **Never limited or origin-checked:** `/webhooks/*` — the §13.9 inbound path has a
 * 150 ms Redis budget of its own and a provider retry must never meet a 429 — `/health*`,
 * and CORS preflights.
 */

export const RATE_LIMIT_WINDOW_MS = 60_000;
const REDIS_BUDGET_MS = 50;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    normaliseOrigin(portalUrl(env)),
    normaliseOrigin(env.ADMIN_URL ?? 'http://localhost:3001'),
  ];
}

export function rateLimitPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.API_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw.trim() === '') return 600;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 600;
}

export function isExemptPath(path: string): boolean {
  return (
    path === '/health' ||
    path.startsWith('/health/') ||
    path === '/webhooks' ||
    path.startsWith('/webhooks/')
  );
}

export type RequestVerdict =
  | { allow: true }
  | { allow: false; code: 'ORIGIN_NOT_ALLOWED' }
  | { allow: false; code: 'RATE_LIMITED'; retryAfterSeconds: number };

/** The origin half, pure. */
export function originVerdict(
  method: string,
  path: string,
  origin: string | undefined,
  allowed: ReadonlySet<string>,
): RequestVerdict {
  if (!STATE_CHANGING.has(method.toUpperCase()) || isExemptPath(path) || !origin)
    return { allow: true };
  return allowed.has(normaliseOrigin(origin))
    ? { allow: true }
    : { allow: false, code: 'ORIGIN_NOT_ALLOWED' };
}

/** The budget half, pure: `count` is the window's counter after this request, null = Redis did not answer. */
export function budgetVerdict(count: number | null, limit: number, nowMs: number): RequestVerdict {
  if (limit <= 0 || count === null || count <= limit) return { allow: true };
  const windowEnds = (Math.floor(nowMs / RATE_LIMIT_WINDOW_MS) + 1) * RATE_LIMIT_WINDOW_MS;
  return {
    allow: false,
    code: 'RATE_LIMITED',
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnds - nowMs) / 1000)),
  };
}

export interface RequestLimitDeps {
  /** `RedisCache.increment` — fixed-window counter, null when Redis did not answer. */
  increment(key: string, ttlSeconds: number, timeoutMs: number): Promise<number | null>;
  /** `redisKeys.apiRequestWindow`. */
  windowKey(ip: string, window: number): string;
  now?: () => number;
}

export function registerRequestLimits(
  app: NestFastifyApplication,
  deps: RequestLimitDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allowed = new Set(allowedOrigins(env));
  const limit = rateLimitPerMinute(env);
  const now = deps.now ?? Date.now;

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const path = request.url.split('?')[0] ?? '';
      if (isExemptPath(path)) return;
      const origin =
        typeof request.headers.origin === 'string' ? request.headers.origin : undefined;

      const byOrigin = originVerdict(request.method, path, origin, allowed);
      if (!byOrigin.allow) return refuse(reply, byOrigin, origin, allowed);

      if (limit <= 0) return;
      const at = now();
      const count = await deps.increment(
        deps.windowKey(clientBucket(request.ip), Math.floor(at / RATE_LIMIT_WINDOW_MS)),
        2 * (RATE_LIMIT_WINDOW_MS / 1000),
        REDIS_BUDGET_MS,
      );
      const byBudget = budgetVerdict(count, limit, at);
      if (!byBudget.allow) return refuse(reply, byBudget, origin, allowed);
    });
}

/** What `refuse` needs of a reply — structural, because the API resolves two fastify builds. */
interface ReplyLike {
  header(name: string, value: string): unknown;
  code(status: number): { send(body: unknown): unknown };
}

const MESSAGES = {
  ORIGIN_NOT_ALLOWED: 'That request came from a page we do not recognise.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
} as const;

function refuse(
  reply: ReplyLike,
  verdict: Exclude<RequestVerdict, { allow: true }>,
  origin: string | undefined,
  allowed: ReadonlySet<string>,
): unknown {
  // This hook can answer before @fastify/cors has added its headers, and a browser shown a
  // 429 without them reports a network error instead — the portal would say "could not
  // reach the server" rather than "wait a moment".
  if (origin && allowed.has(normaliseOrigin(origin))) {
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-credentials', 'true');
    reply.header('vary', 'Origin');
  }
  if (verdict.code === 'RATE_LIMITED')
    void reply.header('retry-after', String(verdict.retryAfterSeconds));
  return reply
    .code(ERROR_STATUS[verdict.code])
    .send({ code: verdict.code, message: MESSAGES[verdict.code] });
}

export function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}
