import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { AgentEvents } from '../agents';
import { EventsService } from '../events';
import { JobRecordsService, LOST_JOB_REASON, type LostJob } from '../jobs';
import { RuntimeCacheService } from '../runtime-cache';
import { VoicesService } from '../voices';
import { WalletService } from '../wallet';
import { WebhookProcessingService } from '../webhooks';

/**
 * The §13.11 scheduled jobs that are live in D4 and D5. The rest of the table
 * (`number-rental`, `low-balance-alerts`, `auto-topup`, `reconcile-calls`,
 * `concurrency-monitor`, `number-release`, `daily-digest`, `kb-sync`) is registered as a
 * skeleton by `SCHEDULES` so the schedule exists, the worker logs it, and the day that
 * owns each one fills in the body.
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
  ) {}

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
