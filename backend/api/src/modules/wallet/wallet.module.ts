import { Module, type OnModuleInit, forwardRef } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { EventsModule, EventsService } from '../events';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * Spec §13.1 `wallet`. Owns every write to credit_ledger and credit_lots. Billing is a
 * sibling that depends on it (a paid purchase becomes a grant) and that the controller
 * depends on (checkout), hence the forward reference.
 *
 * D4 wires the `wallet` SSE topic here: every non-duplicate ledger row becomes one frame
 * on `GET /events`, so the D5 balance card updates the moment a call is billed rather
 * than on the next poll. Low-balance alerts and auto top-up hang off the same listener
 * when they land (§5.4).
 */
@Module({
  // EventsModule is @Global, but it is imported here anyway so that any module graph
  // containing the wallet — a test module, a future worker variant — resolves EventsService
  // without having to know that the wallet publishes.
  imports: [EventsModule, forwardRef(() => BillingModule)],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule implements OnModuleInit {
  constructor(
    private readonly wallet: WalletService,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.wallet.onLedgerWrite(async ({ workspaceId, write }) => {
      await this.events.publish(workspaceId, 'wallet', 'ledger', {
        delta: write.delta,
        balance_after: write.balance_after,
        reason: write.reason,
        ref_id: write.ref_id,
      });
    });
  }
}
