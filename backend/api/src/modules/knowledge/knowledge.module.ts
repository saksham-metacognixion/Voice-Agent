import { Module, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PlatformConfigModule } from '../config';
import { JOBS, JobHandlerRegistry, type KnowledgeSyncJob, QUEUES } from '../jobs';
import { RetellModule } from '../retell';
import { KnowledgeSyncWorker } from './knowledge-sync.worker';
import { AgentKnowledgeController, KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

/**
 * Spec §13.1 `knowledge` (W4). The route creates the row and queues the work; the
 * `knowledge-sync` handler on the `provisioning` queue does the platform round trips.
 * Registered here like every other module's handlers: the API registers and never runs
 * it, `src/worker.ts` does.
 */
@Module({
  imports: [RetellModule, PlatformConfigModule],
  controllers: [AgentKnowledgeController, KnowledgeController],
  providers: [KnowledgeService, KnowledgeSyncWorker],
  exports: [KnowledgeService, KnowledgeSyncWorker],
})
export class KnowledgeModule implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly worker: KnowledgeSyncWorker,
  ) {}

  onModuleInit(): void {
    this.registry.register<KnowledgeSyncJob>(QUEUES.provisioning, JOBS.knowledgeSync, (job: Job<KnowledgeSyncJob>) => this.worker.run(job));
  }
}
