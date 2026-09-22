import { z } from 'zod';

export const healthResponse = z.object({
  status: z.literal('ok'),
  service: z.enum(['api', 'worker']),
  env: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

/**
 * GET /health/ready — D7. Liveness (`/health`) says the process answers; readiness says
 * what it can reach. `worker` reads the worker's Redis heartbeat, so one probe on the API
 * also tells an operator whether the queues are being drained. Bounded: every check has
 * its own timeout and a failure is a field, never a 5xx on its own — the HTTP status is
 * 503 only when Postgres or Redis is unreachable.
 */
export const readinessCheck = z.object({
  ok: z.boolean(),
  latency_ms: z.number().nullable(),
  detail: z.string().nullable(),
});
export type ReadinessCheck = z.infer<typeof readinessCheck>;

export const readinessResponse = z.object({
  status: z.enum(['ready', 'degraded']),
  service: z.literal('api'),
  env: z.string(),
  version: z.string(),
  time: z.string(),
  checks: z.object({
    postgres: readinessCheck,
    redis: readinessCheck,
    /** The worker's last heartbeat, if any. `ok` = seen within the last two minutes. */
    worker: readinessCheck.extend({ last_seen: z.string().nullable(), schedulers: z.number().int().nullable() }),
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponse>;
