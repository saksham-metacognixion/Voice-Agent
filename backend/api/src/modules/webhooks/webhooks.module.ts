import { Module, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AuthModule } from '../auth';
import { BillingModule } from '../billing';
import { CallsModule } from '../calls';
import { JOBS, JobHandlerRegistry, type ProcessWebhookJob, QUEUES } from '../jobs';
import { RetellModule } from '../retell';
import { FixtureWriter } from './fixture-writer.service';
import { RetellEventHandler } from './retell-events.handler';
import { WebhookEventsService } from './webhook-events.service';
import { WebhookProcessingService } from './webhook-processing.service';
import { WebhooksController } from './webhooks.controller';

/**
 * Spec §13.1 `webhooks`: the four receivers, the exactly-once store, and the queue
 * hand-off. The `webhooks` queue handler is registered here because this module owns that
 * queue; what it runs are the same services the routes and the admin replay call.
 *
 * `AuthModule` is imported for the Auth0 `user.created` upsert (§13.2) — `UsersService`
 * lives there, not in `workspaces`, because the guard provisions from it too. The arrow
 * points this way and only this way: auth knows nothing about webhooks.
 *
 * It is imported explicitly even though `AuthModule` is `@Global()`: global means "once
 * imported, visible everywhere", not "available without being imported". `AppModule`
 * imports it, `WorkerModule` does not, so leaning on the global registration made the
 * **worker** — the process that actually runs this handler — fail to boot with
 * `Nest can't resolve dependencies of the WebhookProcessingService`. `worker-module.e2e.test.ts`
 * is the regression test.
 */
@Module({
  imports: [AuthModule, RetellModule, BillingModule, CallsModule],
  controllers: [WebhooksController],
  providers: [FixtureWriter, WebhookEventsService, RetellEventHandler, WebhookProcessingService],
  exports: [FixtureWriter, WebhookEventsService, RetellEventHandler, WebhookProcessingService],
})
export class WebhooksModule implements OnModuleInit {
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly processing: WebhookProcessingService,
  ) {}

  onModuleInit(): void {
    this.registry.register<ProcessWebhookJob>(QUEUES.webhooks, JOBS.processWebhook, (job: Job<ProcessWebhookJob>) =>
      this.processing.process(job.data.eventId),
    );
  }
}
