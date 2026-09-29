import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import type { AdminSystemHealthResponse } from '@portal/schemas';
import { resolveAppEnv } from '../../common/env';
import { withTimeout } from '../../common/timeout';
import { StripeGateway } from '../billing';
import { PlatformConfigService, killSwitchActive } from '../config';
import { HEARTBEAT_TTL_S, type WorkerHeartbeatRecord } from '../jobs';
import { RedisCache, redisKeys } from '../redis';
import { RetellGateway } from '../retell';
import { AdminKpisService } from './admin-kpis.service';
import { DAY_MS } from './admin.helpers';

const PROBE_TIMEOUT_MS = 2_500;
/** Provider probes are cached: the strip polls every 30 s from every open console tab. */
const PROVIDER_PROBE_TTL_S = 60;
const PROVIDER_PROBE_KEY = (name: string) => `admin:health:${name}`;

type Check = AdminSystemHealthResponse['api'];

/**
 * Admin §3 "Health strip" (D12 §17): Postgres, Redis, the worker heartbeat (the same
 * probes as `GET /health/ready`), the two providers (one cheap authenticated call each,
 * cached a minute), webhook backlog, failed jobs, live concurrency against the platform
 * allowance, and which kill switches are on. Signals and short details only — never a
 * hostname, a key or a connection string.
 */
@Injectable()
export class AdminSystemService {
  private readonly log = new Logger(AdminSystemService.name);

  constructor(
    private readonly cache: RedisCache,
    private readonly config: PlatformConfigService,
    private readonly stripe: StripeGateway,
    private readonly retell: RetellGateway,
    private readonly kpis: AdminKpisService,
  ) {}

  async health(now = new Date()): Promise<AdminSystemHealthResponse> {
    const [postgres, redis, worker, retell, stripe, backlog, jobs, concurrency, switches] =
      await Promise.all([
        timed(async () => {
          await adminDb.$queryRaw`SELECT 1`;
        }),
        timed(async () => {
          if (!(await this.cache.ping(PROBE_TIMEOUT_MS))) throw new Error('PING did not answer');
        }),
        this.worker(),
        this.provider('retell', () => this.retell.listVoices().then(() => undefined)),
        this.provider('stripe', () => this.stripe.ping()),
        this.webhooks(now),
        this.jobs(now),
        this.kpis.liveConcurrency(now),
        adminDb.killSwitch.findMany({ where: { on: true } }),
      ]);
    const on = switches
      .filter((s) => killSwitchActive({ key: s.key, on: s.on, expiresAt: s.expiresAt }))
      .map((s) => s.key);
    const concurrencySignal: Check['signal'] =
      concurrency.live === null
        ? 'unknown'
        : concurrency.allowance === 0
          ? 'ok'
          : concurrency.live >= concurrency.allowance
            ? 'down'
            : concurrency.live >= concurrency.allowance * 0.8
              ? 'warn'
              : 'ok';
    return {
      time: now.toISOString(),
      env: resolveAppEnv(),
      api: { signal: 'ok', detail: null, latency_ms: 0 },
      postgres,
      redis,
      worker,
      retell,
      stripe: {
        ...stripe,
        last_webhook_at: backlog.lastStripeAt,
        unprocessed: backlog.stripeUnprocessed,
      },
      webhooks: {
        signal: backlog.failed > 0 ? 'warn' : backlog.unprocessed > 20 ? 'warn' : 'ok',
        detail: backlog.failed
          ? `${backlog.failed} failed`
          : backlog.unprocessed
            ? `${backlog.unprocessed} waiting`
            : null,
        latency_ms: null,
        unprocessed: backlog.unprocessed,
        failed: backlog.failed,
      },
      jobs: {
        signal: jobs.failed24h > 0 ? 'warn' : 'ok',
        detail: jobs.failed24h ? `${jobs.failed24h} failed in 24 h` : null,
        latency_ms: null,
        failed_24h: jobs.failed24h,
        queued: jobs.queued,
      },
      concurrency: {
        signal: concurrencySignal,
        detail: concurrency.allowance
          ? `${concurrency.live ?? '?'} of ${concurrency.allowance}`
          : concurrency.live === null
            ? 'Redis did not answer'
            : 'no platform allowance set (CONCURRENCY_PLATFORM_LIMIT)',
        latency_ms: null,
        live: concurrency.live,
        allowance: concurrency.allowance,
      },
      kill_switches_on: on,
    };
  }

  private async worker(): Promise<AdminSystemHealthResponse['worker']> {
    const started = Date.now();
    const record = await this.cache.getJson<WorkerHeartbeatRecord>(
      redisKeys.workerHeartbeat,
      PROBE_TIMEOUT_MS,
    );
    const latency = Date.now() - started;
    if (!record?.at)
      return {
        signal: 'down',
        detail: 'no heartbeat',
        latency_ms: latency,
        last_seen: null,
        schedulers: null,
      };
    const ageS = (Date.now() - new Date(record.at).getTime()) / 1000;
    const fresh = Number.isFinite(ageS) && ageS <= HEARTBEAT_TTL_S;
    return {
      signal: fresh ? 'ok' : 'down',
      detail: fresh ? null : `last heartbeat ${Math.round(ageS)} s ago`,
      latency_ms: latency,
      last_seen: record.at,
      schedulers: record.schedulers ?? null,
    };
  }

  private async provider(name: 'retell' | 'stripe', probe: () => Promise<void>): Promise<Check> {
    const configured =
      name === 'retell' ? this.retell.config.configured : this.stripe.config.configured;
    if (!configured) return { signal: 'unknown', detail: 'not configured', latency_ms: null };
    const cached = await this.cache.getJson<Check>(PROVIDER_PROBE_KEY(name));
    if (cached) return cached;
    const result = await timed(probe);
    const check: Check = {
      ...result,
      detail: result.signal === 'ok' ? null : (result.detail ?? '').slice(0, 80) || 'unreachable',
    };
    await this.cache.setJson(PROVIDER_PROBE_KEY(name), check, PROVIDER_PROBE_TTL_S);
    return check;
  }

  private async webhooks(
    now: Date,
  ): Promise<{
    unprocessed: number;
    failed: number;
    stripeUnprocessed: number;
    lastStripeAt: string | null;
  }> {
    const stale = new Date(now.getTime() - 60_000);
    const [unprocessed, failed, stripeUnprocessed, lastStripe] = await Promise.all([
      adminDb.webhookEvent.count({ where: { processedAt: null, receivedAt: { lt: stale } } }),
      adminDb.webhookEvent.count({ where: { processedAt: null, error: { not: null } } }),
      adminDb.webhookEvent.count({
        where: { provider: 'stripe', processedAt: null, receivedAt: { lt: stale } },
      }),
      adminDb.webhookEvent.findFirst({
        where: { provider: 'stripe' },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true },
      }),
    ]);
    return {
      unprocessed,
      failed,
      stripeUnprocessed,
      lastStripeAt: lastStripe?.receivedAt.toISOString() ?? null,
    };
  }

  private async jobs(now: Date): Promise<{ failed24h: number; queued: number }> {
    const [failed24h, queued] = await Promise.all([
      adminDb.job.count({
        where: { status: 'failed', updatedAt: { gte: new Date(now.getTime() - DAY_MS) } },
      }),
      adminDb.job.count({ where: { status: { in: ['queued', 'running'] } } }),
    ]);
    return { failed24h, queued };
  }
}

async function timed(probe: () => Promise<void>): Promise<Check> {
  const started = Date.now();
  try {
    await withTimeout(PROBE_TIMEOUT_MS, () => probe());
    return { signal: 'ok', latency_ms: Date.now() - started, detail: null };
  } catch (error) {
    return {
      signal: 'down',
      latency_ms: Date.now() - started,
      detail: scrubDetail(error instanceof Error ? error.message : String(error)).slice(0, 120),
    };
  }
}

/**
 * A probe's error text is shown to every staff role, and providers quote what they were
 * given: Stripe's 401 is "Invalid API Key provided: sk_test_…", a driver error can carry
 * the connection string. Strip URLs and anything credential-shaped before it leaves.
 */
export function scrubDetail(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '')
    .replace(/\b(?:sk|rk|pk|whsec)_\S*/g, '[redacted]')
    .replace(/\bkey_\S*/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
