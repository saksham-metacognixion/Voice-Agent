import type { NotificationItemResponse, NotificationKind } from '@portal/schemas';
import { callPath, routes, settingsPath } from '../routes';

/**
 * The §7.2 bell's rows as decisions (ADR 0041): where a row leads and how old it reads.
 * Copy lives in the messages catalogue under `shell.notifications.kind.<kind>`.
 */

/** Where the row leads: the thing it is about, never a page the role cannot open. */
export function notificationHref(item: Pick<NotificationItemResponse, 'kind' | 'meta'>): string {
  const meta = item.meta ?? {};
  switch (item.kind) {
    case 'low_balance':
    case 'auto_topup_failed':
    case 'rental_overdue':
      return routes.app.wallet;
    case 'message_captured':
      return typeof meta.call_id === 'string' && meta.call_id ? callPath(meta.call_id) : routes.app.calls;
    case 'number_active':
    case 'number_released':
      return routes.app.numbers;
    case 'member_joined':
      return settingsPath('team');
    default:
      return routes.app.home;
  }
}

/** The rows the bell may show. Anything the API adds later and this build does not know is skipped, not crashed on. */
export const KNOWN_KINDS: ReadonlySet<string> = new Set<NotificationKind>(['low_balance', 'message_captured', 'number_active', 'auto_topup_failed', 'member_joined', 'rental_overdue', 'number_released']);

export function knownNotifications(items: ReadonlyArray<NotificationItemResponse>): NotificationItemResponse[] {
  return items.filter((i) => KNOWN_KINDS.has(i.kind));
}

/** "3 min ago", "2 h ago", "yesterday", or the date beyond a week — in the portal's language. */
export function relativeAge(iso: string, now: Date, locale: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return '';
  const seconds = Math.round((now.getTime() - at) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (seconds < 60) return rtf.format(0, 'minute');
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return rtf.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 7 * 86_400) return rtf.format(-Math.floor(seconds / 86_400), 'day');
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(at));
}

/** The badge: a count up to 9, "9+" past it, nothing at 0. */
export function unreadBadge(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 9 ? '9+' : String(Math.floor(unread));
}
