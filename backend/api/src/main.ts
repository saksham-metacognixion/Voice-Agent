import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertRlsEnforced, disconnect } from '@portal/db';
import { AppModule } from './app.module';
import { LiveTranscriptRelay } from './modules/calls';
import { registerWebhookRawBody } from './modules/webhooks';
import { assertPortalUrl, portalUrl, resolveAppEnv } from './common/env';

async function bootstrap() {
  // Before anything binds a port: if the runtime connection is not RLS-enforced, every
  // later tenancy guarantee is one forgotten WHERE clause away from being wrong (§17).
  await assertRlsEnforced();
  assertPortalUrl();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
  );

  // Keep the exact request bytes for /webhooks/* and nothing else — provider signatures
  // are HMACs over the wire body, and the parsed object cannot be turned back into it.
  // Before listen(): Fastify locks its content-type parsers on ready().
  registerWebhookRawBody(app);

  // Methods are listed explicitly: the portal's autosave is a PATCH, and the browser
  // refuses it when the preflight answer omits the method (found by the D8 wizard run).
  app.enableCors({
    origin: [
      portalUrl(),
      process.env.ADMIN_URL ?? 'http://localhost:3001',
    ],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Workspace-Id', 'Last-Event-ID'],
    maxAge: 600,
  });
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
