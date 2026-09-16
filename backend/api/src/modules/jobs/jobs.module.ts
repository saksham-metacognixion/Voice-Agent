import { Global, Module } from '@nestjs/common';
import { JobHandlerRegistry, WorkerRuntime } from './job-handlers';
import { JobQueues } from './job-queues.service';
import { SchedulerRegistrar } from './schedulers';

/**
 * BullMQ plumbing only — queues, the handler registry, the worker runtime and the
 * scheduler registrar. No feature module is imported here, so every feature module can
 * depend on it without a cycle. What each job *does* lives with the module that owns the
 * data (webhooks, calls, scheduled).
 */
@Global()
@Module({
  providers: [JobQueues, JobHandlerRegistry, WorkerRuntime, SchedulerRegistrar],
  exports: [JobQueues, JobHandlerRegistry, WorkerRuntime, SchedulerRegistrar],
})
export class JobsModule {}
