import { Module } from '@nestjs/common';
import { FixtureWriter } from './fixture-writer.service';
import { WebhooksController } from './webhooks.controller';

/**
 * Spec §13.1 `webhooks`. D2 ships the receivers and the fixture capture; D3 adds Stripe
 * signature verification, webhook_events exactly-once and the BullMQ hand-off; D4 the
 * real inbound-authorisation path. The raw-body parser this module depends on is
 * registered in main.ts (see raw-body.ts for why it is not a Nest option).
 */
@Module({
  controllers: [WebhooksController],
  providers: [FixtureWriter],
  exports: [FixtureWriter],
})
export class WebhooksModule {}
