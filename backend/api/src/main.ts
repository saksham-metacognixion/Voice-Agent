import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { assertRlsEnforced, disconnect } from '@portal/db';
import { AppModule } from './app.module';
import { registerWebhookRawBody } from './modules/webhooks';

async function bootstrap() {
  // Before anything binds a port: if the runtime connection is not RLS-enforced, every
  // later tenancy guarantee is one forgotten WHERE clause away from being wrong (§17).
  await assertRlsEnforced();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
  );

  // Keep the exact request bytes for /webhooks/* and nothing else — provider signatures
  // are HMACs over the wire body, and the parsed object cannot be turned back into it.
  // Must run before listen(): Fastify locks its content-type parsers on ready().
  // The cast pins the type to this package's fastify. platform-fastify resolves its own
  // copy (5.11 vs 5.12 today) and TypeScript treats the two instance types as unrelated;
  // at runtime it is one object. `pnpm dedupe` would remove the need for this.
  registerWebhookRawBody(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);

  app.enableCors({
    origin: [
      process.env.PORTAL_URL ?? 'http://localhost:3000',
      process.env.ADMIN_URL ?? 'http://localhost:3001',
    ],
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Workspace-Id'],
  });
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on :${port} (${process.env.APP_ENV ?? 'dev'})`, 'Bootstrap');
}

bootstrap().catch(async (error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), undefined, 'Bootstrap');
  await disconnect().catch(() => undefined);
  process.exit(1);
});
