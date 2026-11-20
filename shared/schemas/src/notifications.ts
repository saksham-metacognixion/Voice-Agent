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

// ---------------------------------------------------------------------------
// §7.2 notifications bell (ADR 0041)
// ---------------------------------------------------------------------------

/**
 * The kinds the bell shows, from the `notifications` outbox rows the workspace already
 * writes (§13.1). The spec names five (§7.2): low balance, new messages captured, number
 * provisioning done, failed auto top-up, member joined; the rental and release rows ride
 * along because they are the same outbox. Emails that are not news to a member (the daily
 * digest, an invitation, a purchase review) are never listed.
 */
export const notificationKind = z.enum([
  'low_balance',
  'message_captured',
  'number_active',
  'auto_topup_failed',
  'member_joined',
  'rental_overdue',
  'number_released',
]);
export type NotificationKind = z.infer<typeof notificationKind>;

export const notificationItemResponse = z.object({
  id: uuid,
  kind: notificationKind,
  /** Customer-safe facts the bell renders its line from: `{call_id, from_number}`, `{number_id, e164}`, `{email, role}`, `{balance}`. */
  meta: z.record(z.string(), z.unknown()).nullable(),
  created_at: isoDateTime,
  /** Created after the caller last opened the bell (`POST /notifications/seen`). */
  unread: z.boolean(),
});
export type NotificationItemResponse = z.infer<typeof notificationItemResponse>;

/** GET /notifications — the caller's feed, newest first, 20 at most. */
export const notificationsResponse = z.object({
  items: z.array(notificationItemResponse),
  unread: z.number().int().min(0),
  seen_at: isoDateTime.nullable(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponse>;

/** POST /notifications/seen — the caller opened the bell; everything up to now is read. */
export const notificationsSeenResponse = z.object({ seen_at: isoDateTime });
export type NotificationsSeenResponse = z.infer<typeof notificationsSeenResponse>;

// ---------------------------------------------------------------------------
// Staff announcements (§16 `GET /announcements/active`, admin SA10)
// ---------------------------------------------------------------------------

export const announcementSeverity = z.enum(['info', 'warning', 'danger']);
export type AnnouncementSeverity = z.infer<typeof announcementSeverity>;

/**
 * One in-app banner staff published (admin §8 `announcements`, type `banner`), already
 * filtered to this workspace's audience and to its start/end window. Plain text: the
 * portal renders it as text, never as HTML.
 */
export const announcementResponse = z.object({
  id: uuid,
  severity: announcementSeverity,
  body: z.string(),
  starts_at: isoDateTime.nullable(),
  ends_at: isoDateTime.nullable(),
  /** False = shown until it ends; true = the person may hide it (per browser, there is no per-member row). */
  dismissible: z.boolean(),
  created_at: isoDateTime,
});
export type AnnouncementResponse = z.infer<typeof announcementResponse>;

export const activeAnnouncementsResponse = z.object({ items: z.array(announcementResponse) });
export type ActiveAnnouncementsResponse = z.infer<typeof activeAnnouncementsResponse>;
