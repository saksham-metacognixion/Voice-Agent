import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis';
import { JobHandlerRegistry, WorkerRuntime } from './job-handlers';
import { JobQueues } from './job-queues.service';
import { JobRecordsService } from './job-records.service';
import { JobsController } from './jobs.controller';
import { SchedulerRegistrar } from './schedulers';
import { WorkerHeartbeat } from './worker-heartbeat';

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
  // Explicit for the same reason BillingModule gives: a partial graph must resolve on its own.
  imports: [RedisModule],
  controllers: [JobsController],
  providers: [JobQueues, JobHandlerRegistry, WorkerRuntime, SchedulerRegistrar, JobRecordsService, WorkerHeartbeat],
  exports: [JobQueues, JobHandlerRegistry, WorkerRuntime, SchedulerRegistrar, JobRecordsService, WorkerHeartbeat],
})
export class JobsModule {}
