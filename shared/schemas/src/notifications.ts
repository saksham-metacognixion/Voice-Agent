import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

/**
 * D7 — in-app alerts (§5.4 low balance, §5.3 rental, §14.3 concurrency) and the
 * notification preferences behind them (§15 `notification_settings`).
 *
 *   GET  /alerts/active           the open, undismissed alerts for the D1 banner
 *   POST /alerts/:id/dismiss      hides one; the condition may still be open
 *
 * An alert is *resolved* by the system when its condition clears (balance recovered,
 * calls fell below the threshold) and *dismissed* by a member who has seen it. The banner
 * shows what is neither.
 */
export const alertType = z.enum(['low_balance', 'rental_overdue', 'number_released', 'concurrency', 'auto_topup_failed']);
export type AlertType = z.infer<typeof alertType>;

export const alertResponse = z.object({
  id: uuid,
  type: alertType,
  /** The threshold that was crossed: a percent of the last pack for low_balance, days overdue for rental, live calls for concurrency. */
  threshold: z.number().nullable(),
  /** Customer-safe context: {balance, threshold_credits} | {number_id, e164, days_overdue} | {live, cap}. */
  meta: z.record(z.string(), z.unknown()).nullable(),
  created_at: isoDateTime,
  resolved_at: isoDateTime.nullable(),
});
export type AlertResponse = z.infer<typeof alertResponse>;

export const activeAlertsResponse = z.object({ items: z.array(alertResponse) });
export type ActiveAlertsResponse = z.infer<typeof activeAlertsResponse>;

export const dismissAlertResponse = z.object({ dismissed: z.boolean() });
export type DismissAlertResponse = z.infer<typeof dismissAlertResponse>;

/** `notification_settings` (§15). `new_message` = daily is what receives the daily digest. */
export const newMessageMode = z.enum(['instant', 'daily', 'off']);
export type NewMessageMode = z.infer<typeof newMessageMode>;

export const notificationSettingsResponse = z.object({
  new_message: newMessageMode,
  low_balance_email: z.boolean(),
  low_balance_sms: z.boolean(),
  weekly_summary: z.boolean(),
  /** True when this is the workspace default rather than the caller's own row. */
  is_default: z.boolean(),
});
export type NotificationSettingsResponse = z.infer<typeof notificationSettingsResponse>;

export const updateNotificationSettingsRequest = notificationSettingsResponse.omit({ is_default: true }).partial();
export type UpdateNotificationSettingsRequest = z.infer<typeof updateNotificationSettingsRequest>;
