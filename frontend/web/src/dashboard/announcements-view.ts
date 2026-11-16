import type { AnnouncementResponse, AnnouncementSeverity } from '@portal/schemas';

/**
 * Staff announcements on D1 (ADR 0041): which of the API's rows to show, and the
 * per-browser "hide" for the dismissible ones. There is no per-member row to dismiss
 * into (admin §8 `announcements` has none), so a dismissal is this browser's and a
 * banner that is not dismissible cannot be hidden at all.
 */

export const DISMISSED_KEY = 'portal:announcements:dismissed';

/** The rows to show: dismissible ones this browser hid are left out; non-dismissible ones always show. */
export function visibleAnnouncements(items: ReadonlyArray<AnnouncementResponse>, dismissed: ReadonlySet<string>): AnnouncementResponse[] {
  return items.filter((a) => !(a.dismissible && dismissed.has(a.id)));
}

export function announcementVariant(severity: AnnouncementSeverity): 'info' | 'warning' | 'danger' {
  return severity === 'danger' ? 'danger' : severity === 'warning' ? 'warning' : 'info';
}

/** The stored dismissals, pruned to the ids still active so the list cannot grow for ever. */
export function readDismissed(storage: Pick<Storage, 'getItem'> | null, activeIds: ReadonlyArray<string>): Set<string> {
  try {
    const raw = storage?.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    return new Set(ids.filter((id) => activeIds.includes(id)));
  } catch {
    return new Set();
  }
}

export function writeDismissed(storage: Pick<Storage, 'setItem'> | null, ids: ReadonlySet<string>): void {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // A private window or a full store: the banner comes back next visit, which is the safe side.
  }
}
