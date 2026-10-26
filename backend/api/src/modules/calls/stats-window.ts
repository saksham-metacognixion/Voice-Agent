import type { StatsQuery } from '@portal/schemas';
// The pure local-day arithmetic the digest uses — a file, not the notifications module.
import { localDate, localDayBounds } from '../notifications/local-day';

/**
 * `today` and the `Nd` ranges are whole local days in the workspace timezone, so "today"
 * means the customer's today and not UTC's.
 */
export function resolveWindow(query: StatsQuery, timeZone: string, now: Date = new Date()): { from: Date; to: Date } {
  if (query.range === 'custom') return { from: new Date(query.from!), to: new Date(query.to!) };
  const to = new Date(now.getTime() + 1_000);
  const days = query.range === 'today' ? 1 : query.range === '7d' ? 7 : 30;
  return { from: startOfLocalDay(now, timeZone, days - 1), to };
}

/**
 * Midnight, `daysBack` local days ago, expressed as an instant. Each midnight is resolved
 * with the zone's offset *on that date* (`localDayBounds`), not today's: applying today's
 * offset to a midnight on the other side of a DST change put the window an hour off, and
 * D1's "7 days" then disagreed with D2's, which the portal computes per date (QA-027).
 * An unknown zone falls back to UTC midnights.
 */
export function startOfLocalDay(now: Date, timeZone: string, daysBack: number): Date {
  const today = localDate(now, timeZone) ?? now.toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! - daysBack)).toISOString().slice(0, 10);
  return localDayBounds(date, timeZone)?.start ?? new Date(`${date}T00:00:00.000Z`);
}
