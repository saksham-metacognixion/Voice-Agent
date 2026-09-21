import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth';
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
 * Root HTTP module. Feature modules (spec §13.1: auth, workspaces, agents, prompting,
 * voices, knowledge, numbers, calls, wallet, billing, webhooks, notifications, events,
 * jobs, admin) are registered here as they land, one per day per the plan.
 *
 * Seven things are global and every later module inherits them:
 *   AuthModule              authentication and tenancy, deny by default (D1)
 *   ZodValidationPipe       request bodies validated from @portal/schemas
 *   AllExceptionsFilter     the §16 {code, message, fields?} envelope
 *   RedisModule             the one Redis connection and the safe cache wrapper (D3)
 *   PlatformConfigModule    pricing, flags, kill switches, caps — configuration as data (D3)
 *   JobsModule              BullMQ queues, the handler registry, the schedulers (D4)
 *   EventsModule            SSE and the Redis pub/sub fan-out behind it (D4)
 *
 * The API registers every job handler but starts no BullMQ Worker: `WorkerRuntime.start()`
 * is called from src/worker.ts alone, so the two processes share one module graph and
 * differ only in what they run.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    AuthModule,
    RedisModule,
    AlertsModule,
    CryptoModule,
    PlatformConfigModule,
    JobsModule,
    EventsModule,
    HealthModule,
    RetellModule,
    WalletModule,
    BillingModule,
    RuntimeCacheModule,
    CallsModule,
    WorkspacesModule,
    AgentsModule,
    PromptingModule,
    KnowledgeModule,
    NumbersModule,
    ActivationModule,
    VoicesModule,
    WebhooksModule,
    ScheduledModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
