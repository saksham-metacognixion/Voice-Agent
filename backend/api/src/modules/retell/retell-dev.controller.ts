import { Body, Controller, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isDevEnv } from '../../common/env';
import { AppError } from '../../common/errors/app-error';
import { Public } from '../auth';
import { RetellGateway } from './retell.gateway';

const devWebCallRequest = z.object({
  agent_id: z.string().min(1),
  agent_version: z.number().int().min(0),
  max_call_duration_ms: z.number().int().optional(),
});
class DevWebCallDto extends createZodDto(devWebCallRequest) {}

/**
 * D2 only: mints a web-call access token for the bare test page at
 * frontend/web/app/dev/test-call. The real route is `POST /agents/:id/test/web` (§13.4),
 * which adds authz, email verification, `balance > 0`, the 10/h rate limit and a `calls`
 * row. None of that exists yet, so this one exists only where APP_ENV is explicitly
 * `dev` — an unauthenticated token minter in staging would be free minutes on our Retell
 * bill. RetellModule leaves it out of `controllers` otherwise, and the guard below
 * repeats the check in case someone registers it by hand. Both read APP_ENV through
 * `isDevEnv()`, which treats unset and unrecognised values as prod.
 */
@Public()
@Controller('dev/retell')
export class RetellDevController {
  constructor(private readonly retell: RetellGateway) {}

  @Post('web-call')
  async webCall(@Body() body: DevWebCallDto) {
    if (!isDevEnv()) throw AppError.notFound('Route');
    const call = await this.retell.createWebCall({
      agentId: body.agent_id,
      agentVersion: body.agent_version,
      metadata: { test: true, source: 'dev-test-call-page' },
      maxCallDurationMs: body.max_call_duration_ms,
    });
    // transport + ice_servers must reach the browser SDK: a token minted for the `gateway`
    // transport is refused by the LiveKit path the legacy client defaults to (D2 finding).
    return {
      access_token: call.access_token,
      call_id: call.call_id,
      expires_at: call.expires_at,
      transport: call.transport,
      ice_servers: call.ice_servers,
    };
  }
}
