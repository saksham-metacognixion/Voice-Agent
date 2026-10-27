import { z } from 'zod';

/**
 * `tenants.business_hours_json` and `phone_numbers.hours_override_json` (§11, §13.9).
 *
 * Local wall-clock intervals per weekday in the workspace timezone (IANA name). A day
 * that is absent or empty is closed. An interval whose `close` is at or before `open`
 * runs past midnight (22:00–02:00); `open == close` is the whole day. `closed_dates` are
 * whole days off, YYYY-MM-DD. `date_overrides` (D16) replace one date's hours — a short
 * day before a holiday — and an override with no intervals is a closed day.
 *
 * Used by the inbound hours check, which is on the 300 ms path — so this is deliberately
 * small, and the evaluation below is pure: the API decides with it and the portal previews
 * with it, so "open now" on the screen is the answer a caller gets.
 */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');

export const hoursInterval = z.object({ open: timeOfDay, close: timeOfDay });
export type HoursInterval = z.infer<typeof hoursInterval>;

export const weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type Weekday = z.infer<typeof weekday>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const dateOverride = z.object({
  date: isoDate,
  /** Empty = closed that whole day. */
  intervals: z.array(hoursInterval).default([]),
});
export type DateOverride = z.infer<typeof dateOverride>;

/** Lenient: what is stored is read as it is, so a schedule saved before a rule existed still parses. */
export const businessHours = z.object({
  /** Overrides the workspace timezone when set. */
  timezone: z.string().min(1).optional(),
  days: z.record(weekday, z.array(hoursInterval)).default({}),
  closed_dates: z.array(isoDate).default([]),
  /** Optional, so a schedule written before D16 (and every literal without it) is still one. */
  date_overrides: z.array(dateOverride).optional(),
});
export type BusinessHours = z.infer<typeof businessHours>;

export const MAX_INTERVALS_PER_DAY = 4;
export const MAX_DATE_OVERRIDES = 60;
export const MAX_CLOSED_DATES = 100;

/** True when Intl can resolve the zone name — the same test the inbound check depends on. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The part of each interval that falls on its own day, as [from, to) minutes. */
function sameDaySpans(intervals: readonly HoursInterval[]): Array<[number, number]> {
  return intervals.map((i) => {
    const o = minutesOf(i.open);
    const c = minutesOf(i.close);
    return c > o ? [o, c] : [o, 1440];
  });
}

function overlaps(intervals: readonly HoursInterval[]): boolean {
  const spans = sameDaySpans(intervals).sort((a, b) => a[0] - b[0]);
  return spans.some((s, i) => i > 0 && s[0] < spans[i - 1]![1]);
}

export type HoursProblemKind = 'zone' | 'too_many' | 'overlap' | 'bad_date' | 'duplicate_date' | 'already_closed' | 'too_many_dates';

export interface HoursProblem {
  path: Array<string | number>;
  kind: HoursProblemKind;
}

const PROBLEM_MESSAGES: Record<HoursProblemKind, string> = {
  zone: 'Not a time zone we recognise',
  too_many: `At most ${MAX_INTERVALS_PER_DAY} openings a day`,
  overlap: 'These opening times overlap',
  bad_date: 'Not a real date',
  duplicate_date: 'This date is listed twice',
  already_closed: 'This date is already closed',
  too_many_dates: `At most ${MAX_DATE_OVERRIDES} special dates and ${MAX_CLOSED_DATES} closed dates`,
};

/**
 * What a write must satisfy (PATCH /numbers/:id, PATCH /workspace, W6): a zone Intl
 * knows — an unknown one fails open at the inbound check, so it is refused here instead
 * of silently answering around the clock — at most four intervals a day that do not
 * overlap, real dates, no date both closed and overridden. One list of problems, so the
 * API refuses and the editor explains from the same rules.
 */
export function hoursProblems(hours: BusinessHours): HoursProblem[] {
  const out: HoursProblem[] = [];
  if (hours.timezone !== undefined && !isTimeZone(hours.timezone)) out.push({ path: ['timezone'], kind: 'zone' });
  for (const [day, intervals] of Object.entries(hours.days)) {
    if (!intervals) continue;
    if (intervals.length > MAX_INTERVALS_PER_DAY) out.push({ path: ['days', day], kind: 'too_many' });
    else if (overlaps(intervals)) out.push({ path: ['days', day], kind: 'overlap' });
  }
  const overrides = hours.date_overrides ?? [];
  if (hours.closed_dates.length > MAX_CLOSED_DATES) out.push({ path: ['closed_dates'], kind: 'too_many_dates' });
  if (overrides.length > MAX_DATE_OVERRIDES) out.push({ path: ['date_overrides'], kind: 'too_many_dates' });
  hours.closed_dates.forEach((date, i) => {
    if (!isRealDate(date)) out.push({ path: ['closed_dates', i], kind: 'bad_date' });
    if (hours.closed_dates.indexOf(date) !== i) out.push({ path: ['closed_dates', i], kind: 'duplicate_date' });
  });
  overrides.forEach((o, i) => {
    if (!isRealDate(o.date)) out.push({ path: ['date_overrides', i, 'date'], kind: 'bad_date' });
    if (overrides.findIndex((x) => x.date === o.date) !== i) out.push({ path: ['date_overrides', i, 'date'], kind: 'duplicate_date' });
    if (hours.closed_dates.includes(o.date)) out.push({ path: ['date_overrides', i, 'date'], kind: 'already_closed' });
    if (o.intervals.length > MAX_INTERVALS_PER_DAY) out.push({ path: ['date_overrides', i, 'intervals'], kind: 'too_many' });
    else if (overlaps(o.intervals)) out.push({ path: ['date_overrides', i, 'intervals'], kind: 'overlap' });
  });
  return out;
}

export const businessHoursInput = businessHours.superRefine((hours, ctx) => {
  for (const problem of hoursProblems(hours)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: problem.path, message: PROBLEM_MESSAGES[problem.kind] });
});

// ------------------------------------------------------------------ evaluation

export interface LocalClock {
  weekday: Weekday;
  /** Minutes since local midnight, 0–1439. */
  minutes: number;
  /** YYYY-MM-DD in the zone. */
  date: string;
  /** HH:MM in the zone, for the `current_time` dynamic variable (§9.7). */
  time: string;
}

const WEEKDAYS: Record<string, Weekday> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };
export const WEEKDAY_ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Local wall clock in `timeZone`, or null when the zone name is not one Intl knows. */
export function localClock(at: Date, timeZone: string): LocalClock | null {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      return null;
    }
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value])) as Record<string, string>;
  const weekday = WEEKDAYS[parts.weekday ?? ''];
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // hourCycle h23 still yields "24" on some ICU builds for midnight.
  const h = hour === 24 ? 0 : hour;
  return {
    weekday,
    minutes: h * 60 + minute,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/** The calendar date `days` away from a YYYY-MM-DD, and its weekday. */
export function shiftDate(date: string, days: number): { date: string; weekday: Weekday } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return { date: shifted.toISOString().slice(0, 10), weekday: WEEKDAY_ORDER[(shifted.getUTCDay() + 6) % 7]! };
}

/**
 * A date's own intervals: closed dates have none, an override replaces the weekday's,
 * otherwise the weekday's. Precedence, highest first: closed date → override → weekday.
 */
export function intervalsOn(hours: BusinessHours, date: string, day: Weekday): HoursInterval[] {
  if (hours.closed_dates.includes(date)) return [];
  const override = (hours.date_overrides ?? []).find((o) => o.date === date);
  if (override) return override.intervals;
  return hours.days[day] ?? [];
}

/** A date with no hours of its own at all — closed, or overridden to nothing — is closed until midnight. */
function closedAllDay(hours: BusinessHours, date: string): boolean {
  if (hours.closed_dates.includes(date)) return true;
  const override = (hours.date_overrides ?? []).find((o) => o.date === date);
  return Boolean(override && override.intervals.length === 0);
}

export interface HoursVerdict {
  open: boolean;
  clock: LocalClock | null;
  /** Why the answer is `open` when it was not decided by the schedule. */
  note?: 'no_schedule' | 'invalid_timezone';
}

/**
 * Is the business open at `at`? `open <= now < close`; an interval whose close is at or
 * before its open runs past midnight and is also checked from the previous day. A closed
 * date (or an override with no hours) is closed for the whole date, the early hours a
 * previous evening would have run into included. A zone Intl cannot resolve is treated as
 * open with a note — a misconfigured timezone must never make a phone stop ringing.
 */
export function isOpen(hours: BusinessHours | null | undefined, at: Date, fallbackTimeZone: string): HoursVerdict {
  const tz = hours?.timezone ?? fallbackTimeZone;
  const clock = localClock(at, tz);
  if (!clock) return { open: true, clock: null, note: 'invalid_timezone' };
  if (!hours) return { open: true, clock, note: 'no_schedule' };
  if (closedAllDay(hours, clock.date)) return { open: false, clock };

  for (const interval of intervalsOn(hours, clock.date, clock.weekday)) {
    const o = minutesOf(interval.open);
    const c = minutesOf(interval.close);
    if (c > o ? clock.minutes >= o && clock.minutes < c : clock.minutes >= o || clock.minutes < c) {
      return { open: true, clock };
    }
  }
  // Yesterday's overnight interval still covers the early hours of today.
  const yesterday = shiftDate(clock.date, -1);
  for (const interval of intervalsOn(hours, yesterday.date, yesterday.weekday)) {
    const o = minutesOf(interval.open);
    const c = minutesOf(interval.close);
    if (c <= o && clock.minutes < c) return { open: true, clock };
  }
  return { open: false, clock };
}

/**
 * When the schedule next opens after `at`: days from today (0 = today) and the HH:MM, or
 * null if it does not open within the next eight days. The caller words it.
 */
export function nextOpeningAt(hours: BusinessHours | null | undefined, at: Date, fallbackTimeZone: string): { offset: number; weekday: Weekday; date: string; time: string } | null {
  if (!hours) return null;
  const clock = localClock(at, hours.timezone ?? fallbackTimeZone);
  if (!clock) return null;
  for (let offset = 0; offset < 8; offset += 1) {
    const day = shiftDate(clock.date, offset);
    const intervals = [...intervalsOn(hours, day.date, day.weekday)].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
    for (const interval of intervals) {
      if (offset > 0 || minutesOf(interval.open) > clock.minutes) return { offset, weekday: day.weekday, date: day.date, time: interval.open };
    }
  }
  return null;
}
