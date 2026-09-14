import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assertRlsEnforced, disconnect } from '@portal/db';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint. Same codebase as the API, separate process, separate compose
 * service on the EC2 instance (ADR 0004). BullMQ processors and Job Schedulers
 * (spec §13.11) register here from D4 onward.
 *
 * Job processors call the same services the routes do, so the same tenancy rules apply:
 * anything workspace-scoped runs inside withWorkspace().
 */
async function bootstrap() {
  await assertRlsEnforced();

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  Logger.log(`Worker started (${process.env.APP_ENV ?? 'dev'})`, 'Worker');

  const shutdown = async (signal: string) => {
    Logger.log(`Received ${signal}, shutting down`, 'Worker');
    await app.close();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch(async (error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), undefined, 'Worker');
  await disconnect().catch(() => undefined);
  process.exit(1);
});
