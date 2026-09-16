import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet';
import { RuntimeCacheService } from './runtime-cache.service';

/**
 * The Redis projection the inbound hot path reads (architecture §9). Depends on the
 * wallet for `bal:{ws}` — nothing else may write that key (ADR 0010 §3) — and on the
 * global config module for `caps:{ws}`.
 */
@Module({
  imports: [WalletModule],
  providers: [RuntimeCacheService],
  exports: [RuntimeCacheService],
})
export class RuntimeCacheModule {}
