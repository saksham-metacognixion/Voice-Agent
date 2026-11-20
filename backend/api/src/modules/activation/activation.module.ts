import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { adminDb } from '@portal/db';
import { AgentsModule } from '../agents';
import { AlertsModule } from '../alerts';
import { BillingModule, BillingService } from '../billing';
import { PlatformConfigModule } from '../config';
import { type ActivationJob, JOBS, JobHandlerRegistry, QUEUES } from '../jobs';
import { NumbersModule } from '../numbers';
import { RuntimeCacheModule } from '../runtime-cache';
import { WalletModule } from '../wallet';
import { ActivationController } from './activation.controller';
import { ActivationService } from './activation.service';
import { ActivationWorker } from './activation.worker';

/**
 * §13.8 activation. Depends on `agents` (publish), `numbers` (provision, bind) and
 * `billing` (the paid-session hook); nothing depends on it, which is what keeps the
 * module graph a DAG.
 *
 * The billing hook: `BillingService.onPurchaseCredited` fires after a Checkout Session
 * is credited; when the session carried `agent_id` (W7), the activation starts here on
 * behalf of the workspace owner. Billing does not import this module — it announces,
 * and this module listens.
 */
@Module({
  imports: [AgentsModule, NumbersModule, BillingModule, WalletModule, PlatformConfigModule, RuntimeCacheModule, AlertsModule],
  controllers: [ActivationController],
  providers: [ActivationService, ActivationWorker],
  exports: [ActivationService, ActivationWorker],
})
export class ActivationModule implements OnModuleInit {
  private readonly log = new Logger(ActivationModule.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly worker: ActivationWorker,
    private readonly activation: ActivationService,
    private readonly billing: BillingService,
  ) {}

  onModuleInit(): void {
    this.registry.register<ActivationJob>(QUEUES.provisioning, JOBS.activateAgent, (job: Job<ActivationJob>) => this.worker.run(job));

    this.billing.onPurchaseCredited(async ({ workspaceId, agentId }) => {
      if (!agentId) return;
      const owner = await adminDb.membership.findFirst({ where: { tenantId: workspaceId, role: 'owner' }, select: { userId: true } });
      const agent = await adminDb.agent.findFirst({ where: { id: agentId, tenantId: workspaceId, deletedAt: null }, select: { id: true } });
      if (!owner || !agent) {
        this.log.warn(`purchase credited with agent_id ${agentId} but ${agent ? 'the workspace has no owner' : 'the agent is not in the workspace'}; not activating`);
        return;
      }
      const { job_id } = await this.activation.start({ workspaceId, agentId, userId: owner.userId });
      this.log.log(`purchase credited for workspace ${workspaceId}: activation ${job_id} started for agent ${agentId}`);
    });
  }
}
