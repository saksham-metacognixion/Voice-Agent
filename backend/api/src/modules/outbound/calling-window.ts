import { localClock, type OutboundCountryRule } from '@portal/schemas';

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** How far ahead the next window is looked for. A rule that allows no call for a week is a misconfiguration, not a wait. */
export const NEXT_WINDOW_HORIZON_DAYS = 8;
const STEP_MS = 5 * 60_000;

export interface WindowVerdict {
  open: boolean;
  /** When closed: the first minute every zone allows a call, or null past the horizon. */
  nextAt: Date | null;
}

/**
 * Whether `at` is inside the country's calling window **in every one of its zones**
 * (ADR 0031 §4). Each zone is judged on its own wall clock — its own weekday, its own
 * date for the holiday list, its own DST — so a Saturday in Halifax and a Friday evening
 * in Vancouver are each held to their own day's window. An unknown zone closes the window.
 */
export function insideCallingWindow(rule: OutboundCountryRule, at: Date): boolean {
  return rule.zones.every((zone) => {
    const clock = localClock(at, zone);
    if (!clock) return false;
    if (rule.closed_dates.includes(clock.date)) return false;
    const window = rule.days[clock.weekday];
    if (!window) return false;
    return clock.minutes >= minutesOf(window.start) && clock.minutes < minutesOf(window.end);
  });
}

/**
 * The verdict, and when closed, the next minute it opens. Found by stepping five minutes at
 * a time (DST shifts and half-hour zones included, without modelling either) and then back
 * to the exact minute; past the horizon it is not reliable enough to name, so it is null.
 */
export function callingWindowVerdict(rule: OutboundCountryRule, at: Date, horizonDays = NEXT_WINDOW_HORIZON_DAYS): WindowVerdict {
  if (insideCallingWindow(rule, at)) return { open: true, nextAt: null };
  const start = Math.floor(at.getTime() / 60_000) * 60_000;
  const end = start + horizonDays * 86_400_000;
  for (let t = Math.ceil(start / STEP_MS) * STEP_MS; t <= end; t += STEP_MS) {
    if (!insideCallingWindow(rule, new Date(t))) continue;
    let first = t;
    while (first - 60_000 > start && insideCallingWindow(rule, new Date(first - 60_000))) first -= 60_000;
    return { open: false, nextAt: new Date(first) };
  }
  return { open: false, nextAt: null };
}
