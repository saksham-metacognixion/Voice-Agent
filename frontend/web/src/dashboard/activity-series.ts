import type { StatsResponse } from '@portal/schemas';
import { localDate, shiftDate } from '../lib/format';

export type ActivityMetric = 'calls' | 'minutes' | 'credits';

export interface ActivityPoint {
  /** `YYYY-MM-DD` in the workspace timezone. */
  date: string;
  calls: number;
  missed: number;
  minutes: number;
  credits: number;
}

/**
 * The D1 30-day chart's series: one point per local day of the window, oldest first.
 * `GET /stats` returns a row only for days that had a call; a day without one is a
 * zero, and the axis needs every day to keep its scale honest. The window's days are
 * derived from `to` in the workspace timezone (the API resolved the window there), so
 * a DST change or a UTC midnight never adds or drops a column.
 */
export function activitySeries(stats: Pick<StatsResponse, 'by_day' | 'from' | 'to' | 'timezone'>, days = 30): ActivityPoint[] {
  const byDate = new Map(stats.by_day.map((d) => [d.date, d]));
  const end = new Date(stats.to);
  // `to` is "now + 1 s"; the last local day of the window is the day it falls on.
  const last = localDate(Number.isNaN(end.getTime()) ? new Date() : end, stats.timezone);
  const start = localDate(new Date(stats.from), stats.timezone);
  const out: ActivityPoint[] = [];
  let cursor = shiftDate(last, -(days - 1));
  if (cursor < start) cursor = start;
  for (let i = 0; i < days && cursor <= last; i += 1) {
    const row = byDate.get(cursor);
    out.push({ date: cursor, calls: row?.calls ?? 0, missed: row?.missed ?? 0, minutes: row?.minutes ?? 0, credits: row?.credits ?? 0 });
    cursor = shiftDate(cursor, 1);
  }
  return out;
}

export function seriesTotal(points: ActivityPoint[], metric: ActivityMetric): number {
  return points.reduce((sum, p) => sum + p[metric], 0);
}
