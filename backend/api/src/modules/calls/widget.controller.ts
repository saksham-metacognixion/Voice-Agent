import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { type AgentWidget, type WidgetCallResponse, type WidgetConfig, agentWidgetUpdate, uuid, widgetCallRequest } from '@portal/schemas';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors/app-error';
import { Ctx, Public, Roles } from '../auth';
import type { WorkspaceContext } from '../auth';
import { WidgetService } from './widget.service';

/**
 * D17 §11.5, the customer's side: D3's "Website" tab. Every member reads it; owner and
 * admin change it — the widget lets the public spend the workspace's credits.
 */
@Controller('agents')
export class AgentWidgetController {
  constructor(private readonly widgets: WidgetService) {}

  @Get(':id/widget')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<AgentWidget> {
    return this.widgets.get(ctx, agentIdOf(id));
  }

  @Put(':id/widget')
  @Roles('owner', 'admin')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() body: unknown): Promise<AgentWidget> {
    return this.widgets.update(ctx, agentIdOf(id), agentWidgetUpdate.parse(body));
  }
}

/**
 * D17 §11.5, the visitor's side: the embed frame on the customer's website. `@Public()` —
 * no JWT, no workspace header; the key in the path names the widget, and `WidgetService`
 * decides whether a call may start. The frame is served from the portal's origin, so the
 * §6.2 origin check and CORS already let it through.
 */
@Public()
@Controller('widget')
export class PublicWidgetController {
  constructor(private readonly widgets: WidgetService) {}

  @Get(':key')
  config(@Param('key') key: string): Promise<WidgetConfig> {
    return this.widgets.publicConfig(key);
  }

  @Post(':key/call')
  @HttpCode(201)
  call(@Param('key') key: string, @Body() body: unknown, @Req() request: FastifyRequest): Promise<WidgetCallResponse> {
    return this.widgets.startCall(key, widgetCallRequest.parse(body ?? {}), request.ip);
  }
}

function agentIdOf(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw AppError.notFound('Agent');
  return parsed.data;
}
