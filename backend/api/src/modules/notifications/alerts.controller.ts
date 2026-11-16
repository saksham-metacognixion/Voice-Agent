import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  type ActiveAlertsResponse,
  type DismissAlertResponse,
  type NotificationSettingsResponse,
  type NotificationsResponse,
  type NotificationsSeenResponse,
  updateNotificationSettingsRequest,
  uuid,
} from '@portal/schemas';
import { AllowWithoutMfa, Ctx } from '../auth';
import type { WorkspaceContext } from '../auth';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationsFeedService } from './notifications-feed.service';
import { WorkspaceAlertsService } from './workspace-alerts.service';

/**
 * D1 banner, the §7.2 bell and D6 notification preferences (§16). Every member may read
 * the alerts and dismiss one — a banner is shared by the workspace — every member reads
 * their own bell and marks it seen, and every member edits only their own preferences.
 */
@Controller()
export class AlertsController {
  constructor(
    private readonly alerts: WorkspaceAlertsService,
    private readonly settings: NotificationSettingsService,
    private readonly feed: NotificationsFeedService,
  ) {}

  @Get('notifications')
  notifications(@Ctx() ctx: WorkspaceContext): Promise<NotificationsResponse> {
    return this.feed.list(ctx);
  }

  // Marking the bell read moves no money, so the money-at-risk MFA rule (ADR 0036) does not
  // apply: refused, the badge of an owner who signed in without a factor never cleared.
  @Post('notifications/seen')
  @AllowWithoutMfa()
  notificationsSeen(@Ctx() ctx: WorkspaceContext): Promise<NotificationsSeenResponse> {
    return this.feed.markSeen(ctx);
  }

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
