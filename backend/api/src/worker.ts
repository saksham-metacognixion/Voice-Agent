import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assertRlsEnforced, disconnect } from '@portal/db';
import { WorkerModule } from './worker.module';
import { resolveAppEnv, assertPortalUrl } from './common/env';
import { QUEUES, SchedulerRegistrar, WorkerHeartbeat, WorkerRuntime } from './modules/jobs';
import { RuntimeCacheService } from './modules/runtime-cache';

/**
 * Worker entrypoint. Same codebase as the API, separate process, separate compose service
 * on the EC2 instance (ADR 0004). It owns three things the API does not:
 *
 *   1. the BullMQ Workers that actually run jobs (`WorkerRuntime.start()`),
 *   2. the §13.11 Job Schedulers, upserted idempotently so a redeploy or a second worker
 *      updates a schedule instead of duplicating it (architecture §12),
 *   3. a full `runtime-cache` refresh on boot, so the §13.9 hot path finds `num:{e164}`,
 *      `caps:{ws}` and `bal:{ws}` populated after a Redis restart (ADR 0003 §12 item 5),
 *   4. (D7) the heartbeat — `worker:heartbeat` in Redis and a file for the compose
 *      healthcheck — so an operator can see from the API that jobs are being drained.
 *
 * Job processors call the same services the routes do, so the same tenancy rules apply:
 * anything workspace-scoped runs inside withWorkspace().
 */
async function bootstrap() {
  await assertRlsEnforced();
  assertPortalUrl();

  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();

  const schedulers = await app.get(SchedulerRegistrar).register();
  await app.get(WorkerRuntime).start();
  // D7: the liveness beacon `GET /health/ready` and the compose healthcheck read.
  const heartbeat = app.get(WorkerHeartbeat);
  heartbeat.start({ env: resolveAppEnv(), schedulers: schedulers.present, queues: Object.values(QUEUES) });

  // Best effort: a cold Redis must not stop the worker from draining the queues, and the
  // 5-minute schedule will try again.
  const warmed = await app
    .get(RuntimeCacheService)
    .refreshAll()
    .catch((error: unknown) => {
      Logger.warn(`runtime-cache warm-up failed: ${error instanceof Error ? error.message : String(error)}`, 'Worker');
      return null;
    });
  if (warmed) Logger.log(`runtime cache warm: ${warmed.numbers} numbers across ${warmed.workspaces} workspaces`, 'Worker');

  Logger.log(`Worker started (${resolveAppEnv()})`, 'Worker');

  const shutdown = async (signal: string) => {
    Logger.log(`Received ${signal}, shutting down`, 'Worker');
    heartbeat.stop();
    // Closes the BullMQ Workers first (onApplicationShutdown), so an in-flight job
    // finishes or is returned to the queue rather than being lost with the process.
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
