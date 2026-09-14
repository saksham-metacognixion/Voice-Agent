import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth';
import { WebhooksModule } from './modules/webhooks';

/**
 * Root HTTP module. Feature modules (spec §13.1: auth, workspaces, agents, prompting,
 * voices, knowledge, numbers, calls, wallet, billing, webhooks, notifications, events,
 * jobs, admin) are registered here as they land, one per day per the plan.
 *
 * Three things are global from D1 and every later module inherits them:
 *   AuthModule            authentication and tenancy, deny by default
 *   ZodValidationPipe     request bodies validated from @portal/schemas
 *   AllExceptionsFilter   the §16 {code, message, fields?} envelope
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    AuthModule,
    HealthModule,
    WebhooksModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
