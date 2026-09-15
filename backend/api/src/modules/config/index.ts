export { PlatformConfigModule } from './config.module';
export { PlatformConfigService, CONFIG_TTL_S, CAPS_TTL_S } from './platform-config.service';
export type { CurrentPricing } from './platform-config.service';
export { resolveCaps, resolveFlags, packForTier, rolloutBucket, killSwitchActive } from './config.resolve';
