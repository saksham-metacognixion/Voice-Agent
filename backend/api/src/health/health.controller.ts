import { Controller, Get } from '@nestjs/common';
import { type HealthResponse, healthResponse } from '@portal/schemas';

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
