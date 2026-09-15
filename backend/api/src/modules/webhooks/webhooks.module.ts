import { Module } from '@nestjs/common';
import { BillingModule } from '../billing';
import { RetellModule } from '../retell';
import { FixtureWriter } from './fixture-writer.service';
import { WebhookEventsService } from './webhook-events.service';
import { WebhooksController } from './webhooks.controller';

/**
 * Spec §13.1 `webhooks`. D2 shipped the receivers and the fixture capture; D3 adds Stripe
 * signature verification and the webhook_events exactly-once store; D4 adds the BullMQ
 * hand-off, the Retell lifecycle handler and the real inbound-authorisation path. The
 * raw-body parser this module depends on is registered in main.ts (see raw-body.ts for
 * why it is not a Nest option).
 */
@Module({
  imports: [RetellModule, BillingModule],
  controllers: [WebhooksController],
  providers: [FixtureWriter, WebhookEventsService],
  exports: [FixtureWriter, WebhookEventsService],
})
export class WebhooksModule {}
