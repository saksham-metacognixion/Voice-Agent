import { Module, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
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
 */
@Module({
  imports: [RetellModule, BillingModule, CallsModule],
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
