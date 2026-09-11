import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
  );

  app.enableCors({
    origin: [
      process.env.PORTAL_URL ?? 'http://localhost:3000',
      process.env.ADMIN_URL ?? 'http://localhost:3001',
    ],
    credentials: true,
  });
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on :${port} (${process.env.APP_ENV ?? 'dev'})`, 'Bootstrap');
}

void bootstrap();
