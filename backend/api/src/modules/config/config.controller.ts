import { Controller, Get, Query } from '@nestjs/common';
import { type ActiveAnnouncementsResponse, type FlagsResponse, type PricingResponse, pricingQuery } from '@portal/schemas';
import { z } from 'zod';
import { Ctx, Public } from '../auth';
import type { WorkspaceContext } from '../auth';
import { AnnouncementsService } from './announcements.service';
import { PlatformConfigService } from './platform-config.service';

/**
 * The config reads every surface depends on (§16; admin §5.3).
 *
 *   GET /pricing               public — W7 and the marketing pack cards render it before sign-in.
 *   GET /flags                 workspace-scoped — the answer depends on the plan tier and overrides.
 *   GET /announcements/active  workspace-scoped — the SA10 banners for this plan, country or list (ADR 0041).
 *
 * Both are served from Redis with a 60 s TTL, so a publish is visible within a minute
 * even if the invalidation were missed.
 */
@Controller()
export class ConfigController {
  constructor(
    private readonly config: PlatformConfigService,
    private readonly banners: AnnouncementsService,
  ) {}

  @Public()
  @Get('pricing')
  pricing(@Query() query: z.input<typeof pricingQuery>): Promise<PricingResponse> {
    // Parsed here, not by the global pipe: nestjs-zod only fires on a ZodDto metatype, and
    // this parameter is a plain inferred type. Without it `?region=ca` reaches the filter
    // in lower case and silently drops every region-restricted pack.
    const { region, pack } = pricingQuery.parse(query);
    return this.config.pricingResponse(region, pack);
  }

  @Get('flags')
  flags(@Ctx() ctx: WorkspaceContext): Promise<FlagsResponse> {
    return this.config.flagsFor(ctx.workspaceId);
  }

  @Get('announcements/active')
  announcements(@Ctx() ctx: WorkspaceContext): Promise<ActiveAnnouncementsResponse> {
    return this.banners.active(ctx);
  }
}
