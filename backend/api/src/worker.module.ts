import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BillingModule } from './modules/billing';
import { CallsModule } from './modules/calls';
import { PlatformConfigModule } from './modules/config';
import { EventsModule } from './modules/events';
import { JobsModule } from './modules/jobs';
import { ActivationModule } from './modules/activation';
import { AgentsModule } from './modules/agents';
import { AlertsModule } from './modules/alerts';
import { CryptoModule } from './modules/crypto';
import { KnowledgeModule } from './modules/knowledge';
import { NotificationsModule } from './modules/notifications';
import { NumbersModule } from './modules/numbers';
import { PromptingModule } from './modules/prompting';
import { RedisModule } from './modules/redis';
import { RetellModule } from './modules/retell';
import { RuntimeCacheModule } from './modules/runtime-cache';
import { ScheduledModule } from './modules/scheduled';
import { VoicesModule } from './modules/voices';
import { WalletModule } from './modules/wallet';
import { WebhooksModule } from './modules/webhooks';
import { WorkspacesModule } from './modules/workspaces';

/**
 * The worker imports the same feature modules as the API. Job processors call
 * `CallsService`, `WalletService`, `BillingService` and `PlatformConfigService` directly —
 * the same services the routes call. Controllers registered by these modules are inert
 * here: the worker is an application context, it never listens.
 *
 * Every module registers its handlers in `onModuleInit`; `src/worker.ts` then starts the
 * BullMQ Workers and upserts the §13.11 schedulers.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    RedisModule,
    AlertsModule,
    CryptoModule,
    PlatformConfigModule,
    JobsModule,
    EventsModule,
    RetellModule,
    WalletModule,
    BillingModule,
    RuntimeCacheModule,
    CallsModule,
    WorkspacesModule,
    AgentsModule,
    PromptingModule,
    KnowledgeModule,
    NotificationsModule,
    NumbersModule,
    ActivationModule,
    VoicesModule,
    WebhooksModule,
    ScheduledModule,
  ],
})
export class WorkerModule {}
