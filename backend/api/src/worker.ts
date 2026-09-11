import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint. Same codebase as the API, separate process, separate Railway service.
 * BullMQ processors and Job Schedulers (spec §13.11) register here from D4 onward.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  Logger.log(`Worker started (${process.env.APP_ENV ?? 'dev'})`, 'Worker');

  const shutdown = async (signal: string) => {
    Logger.log(`Received ${signal}, shutting down`, 'Worker');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
