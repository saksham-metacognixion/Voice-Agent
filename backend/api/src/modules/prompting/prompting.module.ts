import { Module, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AgentsModule } from '../agents';
import { JOBS, JobHandlerRegistry, type PromptingJob, QUEUES } from '../jobs';
import { GenerationWorker } from './generation.worker';
import { PromptingController } from './prompting.controller';
import { PromptingService } from './prompting.service';
import { PROMPT_PROVIDER, createPromptProvider } from './providers';

/**
 * Spec §13.1 `prompting` — brief → prompt, and the §9.6 feedback patch.
 *
 * The provider is a factory over the environment (ADR 0009: `PromptingService →
 * PromptProvider → AnthropicProvider`), so which vendor and which model run is a
 * configuration question and nothing in this module knows the answer.
 *
 * Both queue handlers are registered here, at module init, exactly as the calls and
 * webhooks modules register theirs: the API registers them and starts no Worker, and
 * `src/worker.ts` is what actually runs them.
 */
@Module({
  imports: [AgentsModule],
  controllers: [PromptingController],
  providers: [
    { provide: PROMPT_PROVIDER, useFactory: () => createPromptProvider() },
    PromptingService,
    GenerationWorker,
  ],
  exports: [PromptingService, GenerationWorker, PROMPT_PROVIDER],
})
export class PromptingModule implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly worker: GenerationWorker,
  ) {}

  onModuleInit(): void {
    const run = (job: Job<PromptingJob>) => this.worker.run(job);
    this.registry.register<PromptingJob>(QUEUES.prompting, JOBS.generateAgent, run);
    this.registry.register<PromptingJob>(QUEUES.prompting, JOBS.patchAgent, run);
  }
}
