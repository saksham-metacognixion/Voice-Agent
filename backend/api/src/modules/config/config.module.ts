import { Global, Module } from '@nestjs/common';
import { AlertsModule } from '../alerts';
import { ConfigController } from './config.controller';
import { AnnouncementsService } from './announcements.service';
import { BankOfCanadaClient } from './bank-of-canada.client';
import { ExchangeRatesService } from './exchange-rates.service';
import { PlatformConfigService } from './platform-config.service';

/**
 * Configuration as data (§13.12, admin §5). Global: wallet reads rates and the wallet
 * policy, billing reads packs, the inbound path reads caps, agents read the stack.
 * `PlatformConfigService`, not `ConfigService` — that name is @nestjs/config's, which
 * reads environment variables and has nothing to do with pricing.
 */
@Global()
@Module({
  // ADR 0049: a failed exchange-rate refresh pages ops. Imported, not assumed from the app
  // graph, so the module stands on its own wherever it is the only thing loaded.
  imports: [AlertsModule],
  controllers: [ConfigController],
  providers: [PlatformConfigService, AnnouncementsService, BankOfCanadaClient, ExchangeRatesService],
  exports: [PlatformConfigService, AnnouncementsService, BankOfCanadaClient, ExchangeRatesService],
})
export class PlatformConfigModule {}
