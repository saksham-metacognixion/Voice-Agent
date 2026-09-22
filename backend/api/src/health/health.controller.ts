import { Controller, Get, Res } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { type HealthResponse, type ReadinessCheck, type ReadinessResponse, healthResponse, readinessResponse } from '@portal/schemas';
import type { FastifyReply } from 'fastify';
import { HEARTBEAT_TTL_S, type WorkerHeartbeatRecord } from '../modules/jobs/worker-heartbeat';
import { Public } from '../modules/auth';
import { RedisCache, redisKeys } from '../modules/redis';
import { resolveAppEnv } from '../common/env';
import { withTimeout } from '../common/timeout';

/** Budget for each readiness probe. Readiness must answer even when a dependency hangs. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Liveness and readiness. @Public() because the callers cannot hold an Auth0 token: the
 * compose healthcheck, Caddy, and whatever uptime monitor we point at api.<domain>.
 *
 * `/health` says the process answers and leaks nothing a DNS lookup does not already
 * tell you. `/health/ready` (D7) says what it can reach — Postgres, Redis, and whether
 * the worker's heartbeat is fresh — and answers 503 when Postgres or Redis is down, so a
 * load balancer or a deploy script can gate on it. Field values are booleans, latencies
 * and a short reason; never a connection string or a hostname.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly cache: RedisCache) {}

  @Get()
  get(): HealthResponse {
    return healthResponse.parse({
      status: 'ok',
      service: 'api',
      env: resolveAppEnv(),
      version: process.env.npm_package_version ?? '0.0.1',
      time: new Date().toISOString(),
    });
  }

  @Get('ready')
  async ready(@Res() reply: FastifyReply): Promise<void> {
    const [postgres, redis, worker] = await Promise.all([this.probePostgres(), this.probeRedis(), this.probeWorker()]);
    const body: ReadinessResponse = readinessResponse.parse({
      status: postgres.ok && redis.ok ? 'ready' : 'degraded',
      service: 'api',
      env: resolveAppEnv(),
      version: process.env.npm_package_version ?? '0.0.1',
      time: new Date().toISOString(),
      checks: { postgres, redis, worker },
    });
    void reply.code(body.status === 'ready' ? 200 : 503).send(body);
  }

  private async probePostgres(): Promise<ReadinessCheck> {
    return timed(async () => {
      await adminDb.$queryRaw`SELECT 1`;
    });
  }

  private async probeRedis(): Promise<ReadinessCheck> {
    return timed(async () => {
      if (!(await this.cache.ping(PROBE_TIMEOUT_MS))) throw new Error('PING did not answer');
    });
  }

  private async probeWorker(): Promise<ReadinessCheck & { last_seen: string | null; schedulers: number | null }> {
    const started = Date.now();
    const record = await this.cache.getJson<WorkerHeartbeatRecord>(redisKeys.workerHeartbeat, PROBE_TIMEOUT_MS);
    const latency = Date.now() - started;
    if (!record?.at) return { ok: false, latency_ms: latency, detail: 'no heartbeat', last_seen: null, schedulers: null };
    const ageS = (Date.now() - new Date(record.at).getTime()) / 1000;
    const fresh = Number.isFinite(ageS) && ageS <= HEARTBEAT_TTL_S;
    return { ok: fresh, latency_ms: latency, detail: fresh ? null : `last heartbeat ${Math.round(ageS)} s ago`, last_seen: record.at, schedulers: record.schedulers ?? null };
  }
}

async function timed(probe: () => Promise<void>): Promise<ReadinessCheck> {
  const started = Date.now();
  try {
    await withTimeout(PROBE_TIMEOUT_MS, () => probe());
    return { ok: true, latency_ms: Date.now() - started, detail: null };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - started, detail: (error instanceof Error ? error.message : String(error)).slice(0, 120) };
  }
}
