import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  type CallbackCheck,
  type CallbackResponse,
  type DncEntryResponse,
  type OutboundOverview,
  type Page,
  callbackRequest,
  dncAddRequest,
  dncQuery,
  kycDetails,
  outboundSettings,
  uuid,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { Ctx, RequireEmailVerified, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { DncService } from './dnc.service';
import { OutboundSettingsService } from './outbound-settings.service';
import { OutboundCallService } from './outbound.service';

/** A platform call id as it appears in a path: anything longer or stranger is no call of ours. */
function callIdOf(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw AppError.notFound('Call');
  return value;
}

/**
 * D18 click-to-call from the D2 call detail (ADR 0031). The check is open to any member —
 * a viewer sees why the button is off — and placing the call is editor and up with a
 * verified email, like every route that spends credits on a call (§16 `EMAIL_UNVERIFIED`).
 */
@Controller('calls')
export class CallbackController {
  constructor(private readonly outbound: OutboundCallService) {}

  @Get(':id/callback')
  check(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<CallbackCheck> {
    return this.outbound.check(ctx, callIdOf(id));
  }

  @Post(':id/callback')
  @HttpCode(201)
  @Roles('owner', 'admin', 'editor')
  @RequireEmailVerified()
  callBack(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<CallbackResponse> {
    return this.outbound.callBack(ctx, callIdOf(id), callbackRequest.parse(body ?? {}));
  }
}

/**
 * D18 — the D6 "Outbound calling" tab. Reading is any member; the voicemail setting and the
 * business verification are owner/admin, because both commit the business.
 */
@Controller('outbound')
export class OutboundSettingsController {
  constructor(private readonly settings: OutboundSettingsService) {}

  @Get()
  overview(@Ctx() ctx: WorkspaceContext): Promise<OutboundOverview> {
    return this.settings.overview(ctx);
  }

  @Put('settings')
  @Roles('owner', 'admin')
  update(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<OutboundOverview> {
    return this.settings.updateSettings(ctx, outboundSettings.parse(body ?? {}));
  }

  @Post('kyc')
  @HttpCode(200)
  @Roles('owner', 'admin')
  submitKyc(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<OutboundOverview> {
    return this.settings.submitKyc(ctx, kycDetails.parse(body ?? {}));
  }
}

/** D18 — the workspace's do-not-call list. Add: editor and up. Remove: owner/admin. */
@Controller('dnc')
export class DncController {
  constructor(private readonly dnc: DncService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() query: Record<string, unknown>): Promise<Page<DncEntryResponse>> {
    return this.dnc.list(ctx, dncQuery.parse(query));
  }

  @Post()
  @HttpCode(201)
  @Roles('owner', 'admin', 'editor')
  add(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<DncEntryResponse> {
    return this.dnc.add(ctx, dncAddRequest.parse(body ?? {}));
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<{ deleted: boolean }> {
    const parsed = uuid.safeParse(id);
    if (!parsed.success) throw AppError.notFound('Entry');
    return this.dnc.remove(ctx, parsed.data);
  }
}
