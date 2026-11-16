import { Global, Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { AnnouncementsService } from './announcements.service';
import { PlatformConfigService } from './platform-config.service';

/**
 * Configuration as data (§13.12, admin §5). Global: wallet reads rates and the wallet
 * policy, billing reads packs, the inbound path reads caps, agents read the stack.
 * `PlatformConfigService`, not `ConfigService` — that name is @nestjs/config's, which
 * reads environment variables and has nothing to do with pricing.
 */
@Global()
@Module({
  controllers: [ConfigController],
  providers: [PlatformConfigService, AnnouncementsService],
  exports: [PlatformConfigService, AnnouncementsService],
})
export class PlatformConfigModule {}
