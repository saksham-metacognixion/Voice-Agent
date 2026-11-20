import type { NotificationKind } from '@portal/schemas';
import { notificationKind } from '@portal/schemas';

/**
 * The §7.2 bell as a read over the `notifications` outbox (ADR 0041): the rows that are
 * news to a member, the facts the bell may show from each, and what "unread" means.
 * Pure, so the service only fetches and maps.
 */

/** What the bell lists. Everything else in the outbox (the digest, an invitation, a staff review) is not. */
export const FEED_KINDS: readonly NotificationKind[] = notificationKind.options;

/** Outbox channels that stand for an event the member should hear about. `none` is a recorded decision not to send. */
export const FEED_CHANNELS = ['email', 'in_app'] as const;

/**
 * The payload keys the bell may read. The outbox row also carries the email's `text` and
 * `html`, which are the member's own mail and never go into a list every member sees.
 */
const META_KEYS = ['balance', 'pct', 'number_id', 'e164', 'days_overdue', 'call_id', 'from_number', 'email', 'role', 'name'] as const;

export function feedMeta(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out: Record<string, unknown> = {};
  for (const key of META_KEYS) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** A row is unread until the member opens the bell after it was written. */
export function isUnread(createdAt: Date, seenAt: Date | null): boolean {
  return seenAt === null || createdAt.getTime() > seenAt.getTime();
}

export function isFeedKind(kind: string): kind is NotificationKind {
  return (FEED_KINDS as readonly string[]).includes(kind);
}
