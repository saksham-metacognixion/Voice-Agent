import { Module, forwardRef } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { BillingService } from './billing.service';
import { StripeEventHandler } from './stripe-events.handler';
import { StripeConfig } from './stripe.config';
import { StripeGateway } from './stripe.gateway';

/**
 * Spec §13.1 `billing`: Stripe Checkout, fulfilment, and the event router the webhooks
 * module calls. `StripeGateway` is exported so nothing else imports the SDK.
 */
@Module({
  imports: [forwardRef(() => WalletModule)],
  providers: [{ provide: StripeConfig, useFactory: () => new StripeConfig() }, StripeGateway, BillingService, StripeEventHandler],
  exports: [StripeGateway, StripeConfig, BillingService, StripeEventHandler],
})
export class BillingModule {}
