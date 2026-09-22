import { Module, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AlertsModule } from '../alerts';
import { PlatformConfigModule } from '../config';
import {
  type InboundDecisionJob,
  JOBS,
  JobHandlerRegistry,
  QUEUES,
  type RefreshNumberJob,
  type WarmWorkspaceJob,
} from '../jobs';
import { NotificationsModule } from '../notifications';
import { RetellModule } from '../retell';
import { RuntimeCacheModule, RuntimeCacheService } from '../runtime-cache';
import { WalletModule } from '../wallet';
import { CallsController, StatsController } from './calls.controller';
import { CallsQueryService } from './calls.query.service';
import { CallReconciliationService } from './call-reconciliation.service';
import { CallsService } from './calls.service';
import { ConcurrencyMonitorService } from './concurrency-monitor.service';
import { InboundAuthorizationService } from './inbound.service';
import { RecordingSigner } from './recording';

/**
 * Spec §13.1 `calls`: the §13.9 inbound authorisation, the §14 metering that the Retell
 * lifecycle webhooks drive, and the D1/D2 reads.
 *
 * The three `calls`-queue handlers are registered here, at module init, so the API and
 * the worker boot the same graph and only the worker actually runs them (CLAUDE.md: "The
 * API and the worker import the same services"). The Retell lifecycle handler itself is
 * registered by the webhooks module, which owns the `webhooks` queue. D7 adds the two
 * §13.11 monitors that read call data — `reconcile-calls` and `concurrency-monitor` —
 * run from the `scheduled` module.
 */
@Module({
  imports: [RetellModule, WalletModule, PlatformConfigModule, RuntimeCacheModule, AlertsModule, NotificationsModule],
  controllers: [CallsController, StatsController],
  providers: [
    CallsService,
    CallsQueryService,
    InboundAuthorizationService,
    { provide: RecordingSigner, useFactory: () => new RecordingSigner() },
    CallReconciliationService,
    ConcurrencyMonitorService,
  ],
  exports: [CallsService, CallsQueryService, InboundAuthorizationService, RecordingSigner, CallReconciliationService, ConcurrencyMonitorService],
})
export class CallsModule implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly calls: CallsService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  onModuleInit(): void {
    this.registry.register<InboundDecisionJob>(QUEUES.calls, JOBS.inboundDecision, (job: Job<InboundDecisionJob>) =>
      this.calls.recordInboundDecision(job.data),
    );
    this.registry.register<WarmWorkspaceJob>(QUEUES.calls, JOBS.warmWorkspace, (job: Job<WarmWorkspaceJob>) =>
      this.runtimeCache.refresh(job.data.workspaceId),
    );
    this.registry.register<RefreshNumberJob>(QUEUES.calls, JOBS.refreshNumber, (job: Job<RefreshNumberJob>) =>
      this.runtimeCache.refreshNumber(job.data.e164),
    );
  }
}
