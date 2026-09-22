import { Injectable } from '@nestjs/common';
import { withWorkspace } from '@portal/db';
import type { NotificationSettingsResponse, UpdateNotificationSettingsRequest } from '@portal/schemas';
import type { WorkspaceContext } from '../auth';
import { DEFAULT_SETTINGS } from './notifications.service';

/**
 * §15 `notification_settings`, per member (D6 Settings → Notifications). A member's own
 * row overrides the workspace default (`user_id IS NULL`); reading returns whichever
 * applies, writing always writes the member's own row.
 */
@Injectable()
export class NotificationSettingsService {
  async get(ctx: WorkspaceContext): Promise<NotificationSettingsResponse> {
    const rows = await withWorkspace(ctx, (db) => db.notificationSetting.findMany({ where: { tenantId: ctx.workspaceId, OR: [{ userId: ctx.userId }, { userId: null }] } }));
    const own = rows.find((r) => r.userId === ctx.userId);
    const row = own ?? rows.find((r) => r.userId === null);
    if (!row) return { ...DEFAULT_SETTINGS, is_default: true };
    return {
      new_message: (row.newMessage === 'daily' || row.newMessage === 'off' ? row.newMessage : 'instant') as NotificationSettingsResponse['new_message'],
      low_balance_email: row.lowBalanceEmail,
      low_balance_sms: row.lowBalanceSms,
      weekly_summary: row.weeklySummary,
      is_default: !own,
    };
  }

  async update(ctx: WorkspaceContext, input: UpdateNotificationSettingsRequest): Promise<NotificationSettingsResponse> {
    const current = await this.get(ctx);
    const next = {
      newMessage: input.new_message ?? current.new_message,
      lowBalanceEmail: input.low_balance_email ?? current.low_balance_email,
      lowBalanceSms: input.low_balance_sms ?? current.low_balance_sms,
      weeklySummary: input.weekly_summary ?? current.weekly_summary,
    };
    await withWorkspace(ctx, (db) =>
      db.notificationSetting.upsert({
        where: { tenantId_userId: { tenantId: ctx.workspaceId, userId: ctx.userId } },
        create: { tenantId: ctx.workspaceId, userId: ctx.userId, ...next },
        update: next,
      }),
    );
    return this.get(ctx);
  }
}
