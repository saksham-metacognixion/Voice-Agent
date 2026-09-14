import { Controller, Get } from '@nestjs/common';
import { type HealthResponse, healthResponse } from '@portal/schemas';
import { Public } from '../modules/auth';

/**
 * Liveness probe. @Public() because the callers cannot hold an Auth0 token: the compose
 * healthcheck, Caddy, and whatever uptime monitor we point at api.<domain>. It leaks
 * nothing a DNS lookup does not already tell you.
 */
@Public()
@Controller('health')
export class HealthController {
  @Get()
  get(): HealthResponse {
    return healthResponse.parse({
      status: 'ok',
      service: 'api',
      env: process.env.APP_ENV ?? 'dev',
      version: process.env.npm_package_version ?? '0.0.1',
      time: new Date().toISOString(),
    });
  }
}
