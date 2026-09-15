import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BillingModule } from './modules/billing';
import { PlatformConfigModule } from './modules/config';
import { RedisModule } from './modules/redis';
import { RetellModule } from './modules/retell';
import { WalletModule } from './modules/wallet';

/**
 * The worker imports the same feature modules as the API. Job processors (D4) call
 * WalletService, BillingService and PlatformConfigService directly — the same services
 * the routes call. Controllers registered by these modules are inert here: the worker
 * is an application context, it never listens.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    RedisModule,
    PlatformConfigModule,
    RetellModule,
    WalletModule,
    BillingModule,
  ],
})
export class WorkerModule {}
