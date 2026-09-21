import { Module, type OnModuleInit, forwardRef } from '@nestjs/common';
import { AlertsModule } from '../alerts';
import { PlatformConfigModule } from '../config';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { AutoTopupService } from './auto-topup.service';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { InvoicesService } from './invoices.service';
import { StripeEventHandler } from './stripe-events.handler';
import { StripeConfig } from './stripe.config';
import { StripeGateway } from './stripe.gateway';

/**
 * Spec §13.1 `billing`: Stripe Checkout, fulfilment, and the event router the webhooks
 * module calls. `StripeGateway` is exported so nothing else imports the SDK.
 */
@Module({
  // AlertsModule and PlatformConfigModule are @Global(), and are imported here anyway: a
  // global module is visible everywhere *once imported*, and a partial graph (an e2e suite
  // assembling only wallet + billing + webhooks, a worker variant) that never imports it
  // fails to resolve AutoTopupService — the exact failure worker-module.e2e guards against.
  imports: [forwardRef(() => WalletModule), PlatformConfigModule, AlertsModule],
  controllers: [BillingController],
  providers: [{ provide: StripeConfig, useFactory: () => new StripeConfig() }, StripeGateway, BillingService, AutoTopupService, InvoicesService, StripeEventHandler],
  exports: [StripeGateway, StripeConfig, BillingService, AutoTopupService, InvoicesService, StripeEventHandler],
})
export class BillingModule implements OnModuleInit {
  constructor(
    private readonly wallet: WalletService,
    private readonly topups: AutoTopupService,
  ) {}

  /**
   * §5.4: every debit asks whether the balance crossed the auto top-up threshold. Only
   * debits — a grant cannot take a balance *below* anything — and never awaited by the
   * writer beyond the listener's own bounded work (the Stripe call is outside every
   * transaction and the wallet lock is taken again inside `evaluate`).
   */
  onModuleInit(): void {
    this.wallet.onLedgerWrite(async ({ workspaceId, write }) => {
      if (write.delta >= 0) return;
      await this.topups.evaluate(workspaceId, 'ledger');
    });
  }
}
