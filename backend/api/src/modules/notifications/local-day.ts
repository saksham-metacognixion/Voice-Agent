import { localClock } from '../runtime-cache/hours';

/*
 * Local-day arithmetic for the daily digest (§13.11 `daily-digest`). Pure and
 * Intl-based, so it is unit-tested across zones and DST without a clock or a library.
 *
 * "A day" is the interval between two local midnights, converted to instants. On a DST
 * day it is 23 or 25 hours long, which is exactly what "yesterday's calls" means to the
 * business — never a fixed 24 h shifted from UTC.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD of `at` in `timeZone`, or null for a zone Intl does not know. */
export function localDate(at: Date, timeZone: string): string | null {
  return localClock(at, timeZone)?.date ?? null;
}

/** The local hour (0–23) of `at` in `timeZone`, or null for an unknown zone. */
export function localHour(at: Date, timeZone: string): number | null {
  const clock = localClock(at, timeZone);
  return clock ? Math.floor(clock.minutes / 60) : null;
}

/** The calendar day before `date` (YYYY-MM-DD), independent of zone. */
export function previousDate(date: string): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`not a date: ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * The instants bounding local `date` in `timeZone`: `start` is local midnight, `end` is
 * the next local midnight. Null for an unknown zone or a malformed date.
 *
 * A zone whose DST switch happens *at* midnight (some do) has no 00:00 on that day; the
 * first instant of the day is then returned, which is still the correct boundary.
 */
export function localDayBounds(date: string, timeZone: string): { start: Date; end: Date } | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = localMidnight(y, mo, d, timeZone);
  const end = localMidnight(y, mo, d + 1, timeZone);
  if (!start || !end) return null;
  return { start, end };
}

/** The instant at which the wall clock in `timeZone` reads 00:00 on the given day. */
function localMidnight(y: number, mo: number, d: number, timeZone: string): Date | null {
  const wanted = Date.UTC(y, mo - 1, d, 0, 0, 0);
  let guess = wanted;
  for (let i = 0; i < 4; i += 1) {
    const offset = offsetMinutes(new Date(guess), timeZone);
    if (offset === null) return null;
    const next = wanted - offset * 60_000;
    if (next === guess) return new Date(guess);
    guess = next;
  }
  // Oscillating between two offsets: the wall clock skips 00:00 (a midnight DST gap).
  // Take the later of the two candidates, which is the first instant the day exists.
  const offset = offsetMinutes(new Date(guess), timeZone);
  return offset === null ? null : new Date(Math.max(guess, wanted - offset * 60_000));
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** (local wall clock − UTC) in minutes at `at`, e.g. −240 for Toronto in summer. */
export function offsetMinutes(at: Date, timeZone: string): number | null {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      return null;
    }
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value])) as Record<string, string>;
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  if (!Number.isFinite(asUtc)) return null;
  // Truncate to the minute the way the formatter did, so the subtraction is exact.
  const atMinute = at.getTime() - (at.getTime() % 1000);
  return Math.round((asUtc - atMinute) / 60_000);
}
