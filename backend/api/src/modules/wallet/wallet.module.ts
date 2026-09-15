import { Module, forwardRef } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * Spec §13.1 `wallet`. Owns every write to credit_ledger and credit_lots. Billing is a
 * sibling that depends on it (a paid purchase becomes a grant) and that the controller
 * depends on (checkout), hence the forward reference.
 */
@Module({
  imports: [forwardRef(() => BillingModule)],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
