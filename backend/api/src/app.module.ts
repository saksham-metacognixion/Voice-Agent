import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';

/**
 * Root HTTP module. Feature modules (spec §13.1: auth, workspaces, agents, prompting, voices,
 * knowledge, numbers, calls, wallet, billing, webhooks, notifications, events, jobs, admin) are
 * registered here as they land, one per day per the plan.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    HealthModule,
  ],
})
export class AppModule {}
