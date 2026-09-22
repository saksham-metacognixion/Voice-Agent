import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  type ActiveAlertsResponse,
  type DismissAlertResponse,
  type NotificationSettingsResponse,
  updateNotificationSettingsRequest,
  uuid,
} from '@portal/schemas';
import { Ctx } from '../auth';
import type { WorkspaceContext } from '../auth';
import { NotificationSettingsService } from './notification-settings.service';
import { WorkspaceAlertsService } from './workspace-alerts.service';

/**
 * D1 banner and D6 notification preferences (§16). Every member may read the alerts and
 * dismiss one — a banner is shared by the workspace — and every member edits only their
 * own preferences.
 */
@Controller()
export class AlertsController {
  constructor(
    private readonly alerts: WorkspaceAlertsService,
    private readonly settings: NotificationSettingsService,
  ) {}

  @Get('alerts/active')
  active(@Ctx() ctx: WorkspaceContext): Promise<ActiveAlertsResponse> {
    return this.alerts.active(ctx);
  }

  @Post('alerts/:id/dismiss')
  dismiss(@Ctx() ctx: WorkspaceContext, @Param('id') id: string): Promise<DismissAlertResponse> {
    return this.alerts.dismiss(ctx, uuid.parse(id));
  }

  @Get('workspace/notification-settings')
  getSettings(@Ctx() ctx: WorkspaceContext): Promise<NotificationSettingsResponse> {
    return this.settings.get(ctx);
  }

  @Patch('workspace/notification-settings')
  updateSettings(@Ctx() ctx: WorkspaceContext, @Body() body: unknown): Promise<NotificationSettingsResponse> {
    return this.settings.update(ctx, updateNotificationSettingsRequest.parse(body));
  }
}
