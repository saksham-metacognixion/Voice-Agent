import { Global, Module } from '@nestjs/common';
import { JobHandlerRegistry, WorkerRuntime } from './job-handlers';
import { JobQueues } from './job-queues.service';
import { JobRecordsService } from './job-records.service';
import { JobsController } from './jobs.controller';
import { SchedulerRegistrar } from './schedulers';

/**
 * BullMQ plumbing — queues, the handler registry, the worker runtime and the scheduler
 * registrar — plus the `jobs` table behind `202 {job_id}` and `GET /jobs/:id` (§16).
 * No feature module is imported here, so every feature module can depend on it without a
 * cycle. What each job *does* still lives with the module that owns the data (webhooks,
 * calls, prompting, scheduled); what this module owns is how a job is queued, run and
 * reported.
 *
 * The controller is inert in the worker, which is an application context and never listens.
 */
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobQueues, JobHandlerRegistry, WorkerRuntime, SchedulerRegistrar, JobRecordsService],
  exports: [JobQueues, JobHandlerRegistry, WorkerRuntime, SchedulerRegistrar, JobRecordsService],
})
export class JobsModule {}
