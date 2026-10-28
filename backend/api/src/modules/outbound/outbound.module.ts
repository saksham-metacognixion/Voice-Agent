import { Module } from '@nestjs/common';
import { CallsModule } from '../calls';
import { PlatformConfigModule } from '../config';
import { RetellModule } from '../retell';
import { WalletModule } from '../wallet';
import { DncService } from './dnc.service';
import { CallbackController, DncController, OutboundSettingsController } from './outbound.controller';
import { OutboundSettingsService } from './outbound-settings.service';
import { OutboundCallService } from './outbound.service';

/**
 * P2 (D18) outbound click-to-call and its compliance gates (ADR 0031). Sits above `calls`
 * (it writes the call row through `CallsService` and takes the line through `MintSlot`);
 * nothing imports it but the admin module, for the KYC overview it shares.
 */
@Module({
  imports: [CallsModule, RetellModule, WalletModule, PlatformConfigModule],
  controllers: [CallbackController, OutboundSettingsController, DncController],
  providers: [OutboundCallService, OutboundSettingsService, DncService],
  exports: [OutboundSettingsService],
})
export class OutboundModule {}
