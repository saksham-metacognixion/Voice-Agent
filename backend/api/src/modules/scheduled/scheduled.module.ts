import { hostname } from 'node:os';
import { Module, type OnModuleInit, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { JOBS, JobHandlerRegistry, QUEUES, SCHEDULED_JOBS, SCHEDULES, type ScheduleSpec, scheduleLockTtlS } from '../jobs';
import { AlertsModule } from '../alerts';
import { BillingModule } from '../billing';
import { CallsModule } from '../calls';
import { NotificationsModule } from '../notifications';
import { NumbersModule } from '../numbers';
import { RedisCache, RedisModule, redisKeys } from '../redis';
import { RuntimeCacheModule } from '../runtime-cache';
import { VoicesModule } from '../voices';
import { WalletModule } from '../wallet';
import { WebhooksModule } from '../webhooks';
import { ScheduledJobsService } from './scheduled.service';

/**
 * Spec §13.11 `jobs`: one registered handler per scheduled job. A schedule with no
 * handler would fail every tick, so the ones whose day has not come are registered as
 * explicit skeletons that log and return — visible in the worker's startup line, and
 * impossible to forget because `SCHEDULES` and this map are checked against each other by
 * the unit test.
 *
 * Every tick runs under a per-schedule Redis lock (`lock:schedule:{name}`). BullMQ never
 * hands one tick to two workers, but a tick that outlives its interval meets the *next*
 * tick on another worker — and two rental sweeps racing is exactly what the money rules
 * forbid. The loser logs a skip and returns. Redis unreachable means the lock cannot be
 * proven, and the tick is skipped too: every schedule here is a backstop that will run
 * again, so a missed tick is cheaper than a doubled one. But a skip is never silent for
 * long: the lock waits `LOCK_TIMEOUT_MS`, and the third consecutive skip of one schedule
 * raises a `schedule_skipped` ops alert (ScheduledJobsService.noteSkip), because a Redis
 * that is up but slow would otherwise turn every §13.11 job into a successful no-op.
 */
@Module({
  imports: [RedisModule, AlertsModule, RuntimeCacheModule, WebhooksModule, WalletModule, VoicesModule, BillingModule, NumbersModule, NotificationsModule, CallsModule],
  providers: [ScheduledJobsService],
  exports: [ScheduledJobsService],
})
export class ScheduledModule implements OnModuleInit {
  private readonly log = new Logger('ScheduledJobs');

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobs: ScheduledJobsService,
    private readonly cache: RedisCache,
  ) {}

  onModuleInit(): void {
    const live: Partial<Record<string, () => Promise<unknown>>> = {
      [SCHEDULED_JOBS.runtimeCacheRefresh]: () => this.jobs.runtimeCacheRefresh(),
      [SCHEDULED_JOBS.webhookSweeper]: () => this.jobs.webhookSweeper(),
      [SCHEDULED_JOBS.jobSweeper]: () => this.jobs.jobSweeper(),
      [SCHEDULED_JOBS.creditExpiry]: () => this.jobs.creditExpiry(),
      [SCHEDULED_JOBS.autoTopup]: () => this.jobs.autoTopup(),
      [SCHEDULED_JOBS.voiceCache]: () => this.jobs.voiceCache(),
      [SCHEDULED_JOBS.numberRental]: () => this.jobs.numberRental(),
      [SCHEDULED_JOBS.numberRelease]: () => this.jobs.numberRelease(),
      [SCHEDULED_JOBS.lowBalanceAlerts]: () => this.jobs.lowBalanceAlerts(),
      [SCHEDULED_JOBS.reconcileCalls]: () => this.jobs.reconcileCalls(),
      [SCHEDULED_JOBS.concurrencyMonitor]: () => this.jobs.concurrencyMonitor(),
      [SCHEDULED_JOBS.dailyDigest]: () => this.jobs.dailyDigest(),
    };
    for (const spec of SCHEDULES) {
      const handler = live[spec.name];
      this.registry.register(QUEUES.scheduled, spec.name, async (job: Job) => {
        if (!handler) {
          this.log.log(`${spec.name}: skeleton, nothing to do yet`);
          return { outcome: 'skeleton' };
        }
        return this.runLocked(spec, job, handler);
      });
    }
    // Long operations that are not on a schedule but land on this queue later (§16 202 + SSE).
    void JOBS;
  }

  /** One tick, under the schedule's lock, with timing. Exported behaviour for the e2e suite via `ScheduledJobsService.runLocked`. */
  private async runLocked(spec: ScheduleSpec, job: Job, handler: () => Promise<unknown>): Promise<unknown> {
    return this.jobs.runLocked(spec, `${hostname()}:${process.pid}:${job.id ?? 'tick'}`, handler);
  }
}

/** Re-exported so callers can build the same key the module locks on. */
export const scheduleLockKey = (name: string): string => redisKeys.scheduleLock(name);
export { scheduleLockTtlS };
