import './observability/register-api';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertRlsEnforced, disconnect } from '@portal/db';
import { AppModule } from './app.module';
import { LiveTranscriptRelay } from './modules/calls';
import { RedisCache, redisKeys } from './modules/redis';
import { registerWebhookRawBody } from './modules/webhooks';
import { assertPortalUrl, resolveAppEnv } from './common/env';
import { allowedOrigins, registerRequestLimits } from './common/http/request-limits';

async function bootstrap() {
  // Before anything binds a port: if the runtime connection is not RLS-enforced, every
  // later tenancy guarantee is one forgotten WHERE clause away from being wrong (§17).
  await assertRlsEnforced();
  assertPortalUrl();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // 32 MiB, up from Fastify's 1 MiB: a W4 knowledge file (≤ 20 MB) and a W2 document
    // (≤ 10 MB) travel as base64 in JSON, and the default refused any real PDF with a 413.
    new FastifyAdapter({ logger: false, trustProxy: true, bodyLimit: 32 * 1024 * 1024 }),
  );

  // Keep the exact request bytes for /webhooks/* and nothing else — provider signatures
  // are HMACs over the wire body, and the parsed object cannot be turned back into it.
  // Before listen(): Fastify locks its content-type parsers on ready().
  registerWebhookRawBody(app);

  // Methods are listed explicitly: the portal's autosave is a PATCH, and the browser
  // refuses it when the preflight answer omits the method (found by the D8 wizard run).
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Workspace-Id', 'Last-Event-ID'],
    maxAge: 600,
  });
  // §6.2: the origin check on state-changing requests and the per-IP request budget, before
  // routing and body parsing. /webhooks/* and /health* are never touched (request-limits.ts).
  const cache = app.get(RedisCache);
  registerRequestLimits(app, { increment: (key, ttl, timeout) => cache.increment(key, ttl, timeout), windowKey: redisKeys.apiRequestWindow });
  app.enableShutdownHooks();

  // W5's live transcript: a WebSocket upgrade on this server only (the worker binds none).
  app.get(LiveTranscriptRelay).attach(app.getHttpServer());

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on :${port} (${resolveAppEnv()})`, 'Bootstrap');
}

bootstrap().catch(async (error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), undefined, 'Bootstrap');
  await disconnect().catch(() => undefined);
  process.exit(1);
});
