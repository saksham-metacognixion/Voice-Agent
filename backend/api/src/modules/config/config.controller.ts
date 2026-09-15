import { Controller, Get, Logger, Query } from '@nestjs/common';
import { type FlagsResponse, type PricingResponse, pricingQuery } from '@portal/schemas';
import { z } from 'zod';
import { Ctx, Public } from '../auth';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from './platform-config.service';

/**
 * The two config reads every surface depends on (§16; admin §5.3).
 *
 *   GET /pricing   public — W7 and the marketing pack cards render it before sign-in.
 *   GET /flags     workspace-scoped — the answer depends on the plan tier and overrides.
 *
 * Both are served from Redis with a 60 s TTL, so a publish is visible within a minute
 * even if the invalidation were missed.
 */
@Controller()
export class ConfigController {
  constructor(private readonly config: PlatformConfigService) {}

  @Public()
  @Get('pricing')
  pricing(@Query() query: z.input<typeof pricingQuery>): Promise<PricingResponse> {
    // Parsed here, not by the global pipe: nestjs-zod only fires on a ZodDto metatype, and
    // this parameter is a plain inferred type. Without it `?region=ca` reaches the filter
    // in lower case and silently drops every region-restricted pack.
    Logger.debug('Triggered')
    return this.config.pricingResponse(pricingQuery.parse(query).region);
  }

  @Get('flags')
  flags(@Ctx() ctx: WorkspaceContext): Promise<FlagsResponse> {
    return this.config.flagsFor(ctx.workspaceId);
  }
}
