export { VoicesModule } from './voices.module';
export { VoicesService, VOICE_STALE_AFTER_MS, PREVIEW_RATE_LIMIT, sampleUrlOf, vendorSamplePolicy } from './voices.service';
export type { VendorSamplePolicy } from './voices.service';
export { baseLanguage, isMultilingualFrom, languageMatches, languageRank, localeMatches, nativeLanguages } from './voice-languages';
export { VoicesController } from './voices.controller';
