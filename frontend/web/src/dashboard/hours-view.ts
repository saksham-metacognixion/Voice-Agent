import type { BusinessHours, HoursInterval } from '@portal/schemas';

/*
 * D16: the special-dates list of the hours editor, as pure functions of the stored shape.
 */

/** One special date as the editor shows it: closed all day, or its own hours. */
export interface DateRow {
  date: string;
  closed: boolean;
  intervals: HoursInterval[];
}

/** `closed_dates` and `date_overrides` as one sorted list; an override with no hours is a closed day. */
export function dateRows(hours: BusinessHours): DateRow[] {
  const rows: DateRow[] = [
    ...hours.closed_dates.map((date) => ({ date, closed: true, intervals: [] })),
    ...(hours.date_overrides ?? []).map((o) => ({ date: o.date, closed: o.intervals.length === 0, intervals: o.intervals })),
  ];
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** Back to the stored shape: closed days in `closed_dates`, special hours in `date_overrides`. */
export function withDateRows(hours: BusinessHours, rows: DateRow[]): BusinessHours {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const overrides = sorted.filter((r) => !r.closed).map((r) => ({ date: r.date, intervals: r.intervals }));
  const { date_overrides: _drop, ...rest } = hours;
  return { ...rest, closed_dates: sorted.filter((r) => r.closed).map((r) => r.date), ...(overrides.length ? { date_overrides: overrides } : {}) };
}
