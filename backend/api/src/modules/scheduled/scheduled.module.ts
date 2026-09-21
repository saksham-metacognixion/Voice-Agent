import { Module, type OnModuleInit, Logger } from '@nestjs/common';
import { JOBS, JobHandlerRegistry, QUEUES, SCHEDULED_JOBS, SCHEDULES } from '../jobs';
import { BillingModule } from '../billing';
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
 */
@Module({
  imports: [RuntimeCacheModule, WebhooksModule, WalletModule, VoicesModule, BillingModule],
  providers: [ScheduledJobsService],
  exports: [ScheduledJobsService],
})
export class ScheduledModule implements OnModuleInit {
  private readonly log = new Logger('ScheduledJobs');

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly jobs: ScheduledJobsService,
  ) {}

  onModuleInit(): void {
    const live: Partial<Record<string, () => Promise<unknown>>> = {
      [SCHEDULED_JOBS.runtimeCacheRefresh]: () => this.jobs.runtimeCacheRefresh(),
      [SCHEDULED_JOBS.webhookSweeper]: () => this.jobs.webhookSweeper(),
      [SCHEDULED_JOBS.jobSweeper]: () => this.jobs.jobSweeper(),
      [SCHEDULED_JOBS.creditExpiry]: () => this.jobs.creditExpiry(),
      [SCHEDULED_JOBS.autoTopup]: () => this.jobs.autoTopup(),
      [SCHEDULED_JOBS.voiceCache]: () => this.jobs.voiceCache(),
    };
    for (const spec of SCHEDULES) {
      const handler = live[spec.name];
      this.registry.register(QUEUES.scheduled, spec.name, async () => {
        if (!handler) {
          this.log.log(`${spec.name}: skeleton, nothing to do yet`);
          return { outcome: 'skeleton' };
        }
        return handler();
      });
    }
    // Long operations that are not on a schedule but land on this queue later (§16 202 + SSE).
    void JOBS;
  }
}
