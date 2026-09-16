import type { BusinessHours, Weekday } from '@portal/schemas';

/*
 * Business-hours arithmetic for the §13.9 hours check. Pure, so it is unit-tested across
 * timezones and midnight without a clock or a database, and cheap, because it runs on the
 * 300 ms path.
 */

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
const ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

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

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function previous(day: Weekday): Weekday {
  return ORDER[(ORDER.indexOf(day) + 6) % 7]!;
}

export interface HoursVerdict {
  open: boolean;
  clock: LocalClock | null;
  /** Why the answer is `open` when it was not decided by the schedule. */
  note?: 'no_schedule' | 'invalid_timezone';
}

/**
 * Is the business open at `at`? `open <= now < close`; an interval whose close is at or
 * before its open runs past midnight and is also checked from the previous day. A zone
 * Intl cannot resolve is treated as open with a note — a misconfigured timezone must
 * never make a phone stop ringing.
 */
export function isOpen(hours: BusinessHours | null | undefined, at: Date, fallbackTimeZone: string): HoursVerdict {
  const tz = hours?.timezone ?? fallbackTimeZone;
  const clock = localClock(at, tz);
  if (!clock) return { open: true, clock: null, note: 'invalid_timezone' };
  if (!hours) return { open: true, clock, note: 'no_schedule' };

  if (hours.closed_dates.includes(clock.date)) return { open: false, clock };

  const today = hours.days[clock.weekday] ?? [];
  for (const interval of today) {
    const o = toMinutes(interval.open);
    const c = toMinutes(interval.close);
    if (c > o ? clock.minutes >= o && clock.minutes < c : clock.minutes >= o || clock.minutes < c) {
      return { open: true, clock };
    }
  }
  // Yesterday's overnight interval still covers the early hours of today.
  for (const interval of hours.days[previous(clock.weekday)] ?? []) {
    const o = toMinutes(interval.open);
    const c = toMinutes(interval.close);
    if (c <= o && clock.minutes < c) return { open: true, clock };
  }
  return { open: false, clock };
}

/**
 * The next opening time after `at`, as a short human string for the `next_open_time`
 * dynamic variable, or null if the schedule never opens. Looks up to 8 days ahead.
 */
export function nextOpening(hours: BusinessHours | null | undefined, at: Date, fallbackTimeZone: string): string | null {
  if (!hours) return null;
  const tz = hours.timezone ?? fallbackTimeZone;
  const clock = localClock(at, tz);
  if (!clock) return null;
  for (let offset = 0; offset < 8; offset += 1) {
    const day = ORDER[(ORDER.indexOf(clock.weekday) + offset) % 7]!;
    const probeDate = new Date(at.getTime() + offset * 86_400_000);
    const probeClock = localClock(probeDate, tz);
    if (probeClock && hours.closed_dates.includes(probeClock.date)) continue;
    const intervals = [...(hours.days[day] ?? [])].sort((a, b) => toMinutes(a.open) - toMinutes(b.open));
    for (const interval of intervals) {
      if (offset > 0 || toMinutes(interval.open) > clock.minutes) {
        return offset === 0 ? `today at ${interval.open}` : offset === 1 ? `tomorrow at ${interval.open}` : `${capitalize(day)} at ${interval.open}`;
      }
    }
  }
  return null;
}

function capitalize(day: Weekday): string {
  return ({ mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' } as const)[day];
}
