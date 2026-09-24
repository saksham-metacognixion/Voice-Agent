import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { AgentEvents } from '../agents';
import { OpsAlertService } from '../alerts';
import { AutoTopupService, BillingService } from '../billing';
import { CallReconciliationService, ConcurrencyMonitorService } from '../calls';
import { EventsService } from '../events';
import { JobRecordsService, LOST_JOB_REASON, type LostJob, type ScheduleSpec, scheduleLockTtlS } from '../jobs';
import { DailyDigestService, LowBalanceAlertsService, NotificationsService } from '../notifications';
import { NumberRentalService } from '../numbers';
import { RedisCache, redisKeys } from '../redis';
import { RuntimeCacheService } from '../runtime-cache';
import { VoicesService } from '../voices';
import { WalletService } from '../wallet';
import { CallRecoveryService, type CallRecoveryOutcome, WebhookProcessingService } from '../webhooks';

/** What one guarded tick reports back to BullMQ (and the e2e suite). */
export type TickOutcome =
  | { outcome: 'ran'; ms: number; result: unknown }
  | { outcome: 'skipped'; reason: SkipReason };

export type SkipReason = 'locked' | 'redis_unavailable';

/**
 * Budget for the lock round trips. A tick is not the §13.9 hot path, so it waits four
 * times the cache default before it calls Redis "unavailable" — a Redis that is merely
 * busy must not turn every schedule into a silent no-op.
 */
export const LOCK_TIMEOUT_MS = 2_000;

/** Consecutive skips of one schedule before ops is paged. Two in a row is a slow tick; three is something stuck. */
export const SKIP_ALERT_AFTER = 3;

/**
 * The §13.11 scheduled jobs. Every one of them is live as of D7 except `kb-sync`, which
 * `SCHEDULES` still registers as a skeleton. Each body lives with the module that owns
 * the data (wallet, numbers, calls, notifications, billing); this class is the thin
 * dispatch the worker's `scheduled` queue calls, plus the lock every tick runs under.
 *
 * All of these cross workspaces by design, so they run on `adminDb` (ADR 0006).
 */
@Injectable()
export class ScheduledJobsService {
  private readonly log = new Logger(ScheduledJobsService.name);

  constructor(
    private readonly runtimeCache: RuntimeCacheService,
    private readonly webhooks: WebhookProcessingService,
    private readonly wallet: WalletService,
    private readonly voices: VoicesService,
    private readonly jobs: JobRecordsService,
    private readonly events: EventsService,
    private readonly topups: AutoTopupService,
    private readonly billing: BillingService,
    private readonly rental: NumberRentalService,
    private readonly lowBalance: LowBalanceAlertsService,
    private readonly notifications: NotificationsService,
    private readonly digest: DailyDigestService,
    private readonly reconciliation: CallReconciliationService,
    private readonly concurrency: ConcurrencyMonitorService,
    private readonly cache: RedisCache,
    private readonly ops: OpsAlertService,
    private readonly callRecoveryService: CallRecoveryService,
  ) {}

  /** Consecutive skips per schedule, this process. A tick that runs resets its entry. */
  private readonly skips = new Map<string, number>();

  /**
   * Runs `handler` once, under `lock:schedule:{name}`, and logs the tick's start, duration
   * and result. Redis unreachable → skipped (see ScheduledModule), and every skip is
   * counted: the third in a row pages ops (`noteSkip`). The lock is released only while
   * it still holds this tick's token, so a run that overran its TTL cannot free a lock
   * the next tick has since taken.
   */
  async runLocked(spec: ScheduleSpec, token: string, handler: () => Promise<unknown>): Promise<TickOutcome> {
    const key = redisKeys.scheduleLock(spec.name);
    if (!(await this.cache.acquireLock(key, token, scheduleLockTtlS(spec), LOCK_TIMEOUT_MS))) {
      // "Not acquired" covers both a held lock and a Redis that did not answer; one PING tells them apart.
      const reason: SkipReason = (await this.cache.ping(LOCK_TIMEOUT_MS)) ? 'locked' : 'redis_unavailable';
      this.log.warn(reason === 'locked' ? `${spec.name}: skipped — another worker is still running this schedule` : `${spec.name}: skipped — Redis did not answer, cannot take the schedule lock`);
      await this.noteSkip(spec, reason);
      return { outcome: 'skipped', reason };
    }
    this.skips.delete(spec.name);
    const started = Date.now();
    this.log.log(`${spec.name}: tick started`);
    try {
      const result = await handler();
      const ms = Date.now() - started;
      this.log.log(`${spec.name}: done in ${ms} ms → ${summarise(result)}`);
      return { outcome: 'ran', ms, result };
    } catch (error) {
      this.log.error(`${spec.name}: failed after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await this.cache.releaseLock(key, token);
    }
  }

  /**
   * A skipped tick is normal once — a slow tick met the next one — and a problem when it
   * repeats. Every §13.11 schedule quietly doing nothing (lots not expired, rentals not
   * charged, top-ups not reconciled, low-balance emails not sent) is exactly what a slow
   * Redis looks like from here, and BullMQ records each skip as a *successful* job, so
   * nothing else would page. The count is per schedule and per process; the alert fires
   * once per streak, at `SKIP_ALERT_AFTER`.
   */
  private async noteSkip(spec: ScheduleSpec, reason: SkipReason): Promise<void> {
    const count = (this.skips.get(spec.name) ?? 0) + 1;
    this.skips.set(spec.name, count);
    if (count !== SKIP_ALERT_AFTER) return;
    await this.ops.send({
      kind: 'schedule_skipped',
      severity: 'critical',
      title: `Schedule ${spec.name} has skipped ${count} ticks in a row`,
      fields: { schedule: spec.name, reason, consecutive_skips: count, lock_ttl_s: scheduleLockTtlS(spec) },
    });
  }

  // ------------------------------------------------------------------ D7 (§5.3, §5.4, §14.2, §14.3, digest)

  /** §13.11 `number-rental`, hourly: every bought number past its anniversary (NumberRentalService). */
  numberRental(): Promise<{ due: number; charged: number; overdue: number; failed: number; credits: number }> {
    return this.rental.chargeDue();
  }

  /** §13.11 `number-release`, daily: numbers unpaid for `release_after_days_at_zero_balance`. */
  numberRelease(): Promise<{ candidates: number; released: number; failed: number }> {
    return this.rental.releaseOverdue();
  }

  /** §13.11 `low-balance-alerts`, every 15 min: the backstop for the ledger listener, plus the outbox retry. */
  async lowBalanceAlerts(): Promise<{ evaluated: number; opened: number; resolved: number; emailed: number; retried: number }> {
    const swept = await this.lowBalance.sweep();
    const { retried } = await this.notifications.retryFailed();
    return { ...swept, retried };
  }

  /** §13.11 `reconcile-calls`, nightly: yesterday's platform calls against `calls`. */
  async reconcileCalls(): Promise<{ status: string; drift_pct: number | null; missing: number; extra: number; alerted: boolean }> {
    const run = await this.reconciliation.run();
    return { status: run.status, drift_pct: run.metrics?.drift_pct ?? null, missing: run.metrics?.missing.length ?? 0, extra: run.metrics?.extra.length ?? 0, alerted: run.alerted };
  }

  /** §13.11 `call-recovery`, every 5 min: calls whose call_ended / call_analyzed never arrived (ADR 0011 §7). */
  callRecovery(): Promise<CallRecoveryOutcome> {
    return this.callRecoveryService.recover();
  }

  /** §13.11 `concurrency-monitor`, every 5 min: live calls against each plan cap. */
  async concurrencyMonitor(): Promise<{ workspaces: number; live: number; opened: number; resolved: number; platform: string }> {
    const tick = await this.concurrency.tick();
    return { workspaces: tick.workspaces, live: tick.totalLive, opened: tick.opened.length, resolved: tick.resolved.length, platform: tick.platform };
  }

  /** §13.11 `daily-digest`, hourly: each workspace's previous local day, once (DailyDigestService). */
  dailyDigest(): Promise<{ workspaces: number; sent: number; skipped: number; failed: number }> {
    return this.digest.sweep();
  }

  // ------------------------------------------------------------------ D4–D6

  /**
   * §13.11 `auto-topup` (D6): reconcile pending top-ups with Stripe, then evaluate every
   * enabled workspace. Since D10 the same tick asks Stripe about Checkout purchases still
   * `pending` five minutes on — the lost-webhook path for a pack bought in a tab that was
   * closed before `POST /wallet/checkout/confirm` could run.
   */
  async autoTopup(): Promise<{ reconciled: number; evaluated: number; charged: number; checkouts: { checked: number; credited: number } }> {
    const checkouts = await this.billing.reconcilePendingCheckouts();
    const topups = await this.topups.sweep();
    return { ...topups, checkouts };
  }

  /** Periodic full refresh — the backstop for any mutating path that forgot to refresh (architecture §8). */
  runtimeCacheRefresh(): Promise<{ workspaces: number; numbers: number }> {
    return this.runtimeCache.refreshAll();
  }

  /** Re-enqueues webhook rows that were stored but never queued (a Redis blip between the two). */
  webhookSweeper(): Promise<{ found: number; queued: number }> {
    return this.webhooks.sweep();
  }

  /**
   * Writes off `jobs` rows a dead worker left queued/running once the queue confirms
   * nothing will run them again, and tells the customer's stream — the W2 spinner is
   * waiting on exactly that frame. Without this, `jobs_one_active_per_target_idx` would
   * make every later Generate join the corpse forever (JobRecordsService.reconcileStale).
   */
  async jobSweeper(): Promise<{ lost: number }> {
    const lost = await this.jobs.reconcileStale();
    for (const job of lost) await this.announceLost(job);
    return { lost: lost.length };
  }

  private async announceLost(job: LostJob): Promise<void> {
    if (!job.workspaceId || !job.agentId) return;
    await this.events
      .publish(job.workspaceId, AgentEvents.topic(job.agentId), AgentEvents.generationFailed, {
        agent_id: job.agentId,
        job_id: job.jobId,
        reason: LOST_JOB_REASON,
      })
      .catch(() => null);
  }

  /**
   * §13.11 credit-expiry: lots past `expires_at` become `expiry` ledger rows. Every grant
   * and debit already sweeps the workspace it touches (ADR 0010 §3), so this only bounds
   * how long an *idle* workspace carries a lapsed lot.
   */
  async creditExpiry(now = new Date()): Promise<{ workspaces: number; rows: number }> {
    const owners = await adminDb.creditLot.findMany({
      where: { expiresAt: { lte: now }, creditsRemaining: { gt: 0 } },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    let rows = 0;
    for (const { tenantId } of owners) {
      try {
        rows += (await this.wallet.expireLots(tenantId, now)).length;
      } catch (error) {
        this.log.error(`credit-expiry for ${tenantId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rows) this.log.log(`credit-expiry: ${rows} lots written off across ${owners.length} workspaces`);
    return { workspaces: owners.length, rows };
  }

  /**
   * §13.11 `voice-cache`, daily: the W3 picker's catalogue. Non-destructive and retried
   * in-process — a provider outage leaves yesterday's list in place behind the `stale`
   * banner rather than emptying the picker (see VoicesService.refreshCache).
   */
  voiceCache(): Promise<{ fetched: number; written: number; skipped: boolean }> {
    return this.voices.refreshCache();
  }
}

function summarise(result: unknown): string {
  try {
    const text = JSON.stringify(result);
    return text === undefined ? 'void' : text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return String(result);
  }
}
