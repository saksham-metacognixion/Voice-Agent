import { Inject, Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { OpsAlertService } from '../alerts';
import { PlatformConfigService } from '../config';
import { WorkspaceAlertsService } from '../notifications';
import { REDIS, RedisCache, type RedisLike, redisKeys, workspaceOfActiveKey } from '../redis';
import { concurrencyAlertPct, decideConcurrency, platformConcurrencyLimit } from './concurrency-monitor';
import { parseActiveHash } from './inbound.decide';

export const CONCURRENCY_ALERT_KEY = 'concurrency';

export interface ConcurrencyTick {
  workspaces: number;
  totalLive: number;
  opened: string[];
  resolved: string[];
  /** `unknown`: the scan did not finish, so the platform total is a floor and nothing was decided from it. */
  platform: 'ok' | 'alerted' | 'open' | 'unmonitored' | 'unknown';
}

/**
 * §13.11 `concurrency-monitor` (§14.3): who is close to their plan cap, and whether the
 * platform as a whole is.
 *
 * Reads `active:{ws}` — the same hash the §13.9 inbound path reserves into — with SCAN,
 * so a workspace whose calls are all web tests is seen too. Per workspace the decision is
 * `decideConcurrency()` against `caps:{ws}` and `CONCURRENCY_ALERT_PCT`; the alert state is
 * an `alerts` row (`concurrency` key), so five minutes later the same crossing opens
 * nothing, and dropping below the threshold resolves it so the next spike alerts again.
 * A workspace whose hash disappeared (its last call ended) is resolved by the second pass
 * over the open alerts.
 *
 * Redis unreachable is "unknown", not "zero". `scanKeys` answers `null` when Redis did not
 * answer inside its budget and `complete: false` when it stopped at its cap; in both
 * cases the absence of a hash proves nothing, so the second pass and the platform
 * decision are skipped. Resolving on an empty scan would close every open alert (with
 * `resolved` frames) and clear the platform incident while the calls are still live, and
 * the next tick would page ops a second time for the same crossing.
 */
@Injectable()
export class ConcurrencyMonitorService {
  private readonly log = new Logger(ConcurrencyMonitorService.name);

  constructor(
    @Inject(REDIS) private readonly redis: RedisLike,
    private readonly cache: RedisCache,
    private readonly config: PlatformConfigService,
    private readonly alerts: WorkspaceAlertsService,
    private readonly ops: OpsAlertService,
  ) {}

  async tick(now = Date.now(), pct = concurrencyAlertPct(), platformLimit = platformConcurrencyLimit()): Promise<ConcurrencyTick> {
    const out: ConcurrencyTick = { workspaces: 0, totalLive: 0, opened: [], resolved: [], platform: platformLimit ? 'ok' : 'unmonitored' };
    const scan = await this.cache.scanKeys(redisKeys.activeCallsPattern);
    if (!scan) {
      this.log.warn('concurrency-monitor: Redis did not answer the SCAN; nothing decided this tick');
      return out;
    }
    if (!scan.complete) {
      this.log.warn(`concurrency-monitor: SCAN stopped after ${scan.keys.length} keys; alerts open for what was seen, nothing is resolved from absence and the platform total is not judged`);
    }
    const seen = new Set<string>();

    for (const key of scan.keys) {
      const workspaceId = workspaceOfActiveKey(key);
      if (!workspaceId) continue;
      seen.add(workspaceId);
      out.workspaces += 1;
      let live = 0;
      try {
        live = parseActiveHash(await this.redis.hgetall(key), now).live.length;
      } catch (error) {
        this.log.warn(`concurrency-monitor: ${key} unreadable (${String(error)}); skipped`);
        continue;
      }
      out.totalLive += live;
      await this.decideWorkspace(workspaceId, live, pct, out);
    }

    if (!scan.complete) {
      if (platformLimit) out.platform = 'unknown';
      return out;
    }

    // Open alerts for workspaces with no hash any more: all their calls ended. Only safe
    // because the scan walked the whole keyspace — a missing key means a missing hash.
    const open = await adminDb.alert.findMany({ where: { type: 'concurrency', resolvedAt: null }, select: { tenantId: true }, distinct: ['tenantId'] });
    for (const { tenantId } of open) {
      if (seen.has(tenantId)) continue;
      if ((await this.alerts.resolve(tenantId, { key: CONCURRENCY_ALERT_KEY })) > 0) {
        out.resolved.push(tenantId);
        this.log.log(`concurrency ${tenantId}: no live calls, alert resolved`);
      }
    }

    if (platformLimit) out.platform = await this.decidePlatform(out.totalLive, platformLimit, pct);
    if (out.opened.length || out.resolved.length) {
      this.log.log(`concurrency-monitor: ${out.workspaces} workspaces, ${out.totalLive} live calls, ${out.opened.length} alerts opened, ${out.resolved.length} resolved`);
    }
    return out;
  }

  private async decideWorkspace(workspaceId: string, live: number, pct: number, out: ConcurrencyTick): Promise<void> {
    let cap: number;
    try {
      cap = (await this.config.capsFor(workspaceId)).concurrency_cap;
    } catch (error) {
      this.log.warn(`concurrency-monitor: caps for ${workspaceId} unavailable (${String(error)}); skipped`);
      return;
    }
    const isOpen = (await this.alerts.openKeys(workspaceId, 'concurrency')).has(CONCURRENCY_ALERT_KEY);
    const decision = decideConcurrency({ live, cap, pct, open: isOpen });
    if (decision.action === 'open') {
      const opened = await this.alerts.open(workspaceId, {
        type: 'concurrency',
        key: CONCURRENCY_ALERT_KEY,
        threshold: live,
        meta: { live, cap, pct, threshold: decision.threshold },
      });
      if (!opened.created) return;
      out.opened.push(workspaceId);
      this.log.warn(`concurrency ${workspaceId}: ${live} live calls ≥ ${decision.threshold} (${pct}% of cap ${cap}) — alert opened`);
      await this.ops.send({
        kind: 'workspace_concurrency',
        severity: 'warning',
        title: 'A workspace is at its concurrency threshold',
        fields: { workspace_id: workspaceId, live, cap, threshold: decision.threshold, pct },
      });
    } else if (decision.action === 'resolve') {
      if ((await this.alerts.resolve(workspaceId, { key: CONCURRENCY_ALERT_KEY })) > 0) {
        out.resolved.push(workspaceId);
        this.log.log(`concurrency ${workspaceId}: ${live} live calls < ${decision.threshold}, alert resolved`);
      }
    }
  }

  /** Platform-wide: one ops alert per incident, held open in Redis until the total falls back. */
  private async decidePlatform(totalLive: number, limit: number, pct: number): Promise<ConcurrencyTick['platform']> {
    const threshold = Math.max(1, Math.ceil((limit * pct) / 100));
    const isOpen = (await this.cache.get(redisKeys.platformConcurrencyAlert)) !== null;
    if (totalLive >= threshold) {
      if (isOpen) return 'open';
      // Held for a day at most, so a lost DEL cannot silence the monitor forever.
      if (!(await this.cache.setIfAbsent(redisKeys.platformConcurrencyAlert, String(totalLive), 86_400))) return 'open';
      this.log.error(`platform concurrency: ${totalLive} live calls ≥ ${threshold} (${pct}% of ${limit})`);
      await this.ops.send({
        kind: 'platform_concurrency',
        severity: 'critical',
        title: 'Platform-wide live calls at the concurrency threshold',
        fields: { live: totalLive, limit, threshold, pct },
      });
      return 'alerted';
    }
    if (isOpen) {
      await this.cache.del(redisKeys.platformConcurrencyAlert);
      this.log.log(`platform concurrency: ${totalLive} live calls, back below ${threshold}`);
    }
    return 'ok';
  }
}
