import { type BusinessHours, type Weekday, nextOpeningAt } from '@portal/schemas';

/*
 * Business-hours arithmetic for the §13.9 hours check. The evaluation itself lives in
 * `@portal/schemas` (D16) so the portal's "open now" preview runs the same code the
 * inbound path decides with; it is pure, so it is unit-tested across timezones and
 * midnight without a clock or a database, and cheap, because it runs on the 300 ms path.
 */
export { isOpen, localClock } from '@portal/schemas';
export type { HoursVerdict, LocalClock } from '@portal/schemas';

/**
 * The next opening time after `at`, as a short human string for the `next_open_time`
 * dynamic variable, or null if the schedule never opens. Looks up to 8 days ahead. English
 * on purpose: it is read to the agent, whose script is in the agent's language.
 */
export function nextOpening(hours: BusinessHours | null | undefined, at: Date, fallbackTimeZone: string): string | null {
  const next = nextOpeningAt(hours, at, fallbackTimeZone);
  if (!next) return null;
  return next.offset === 0 ? `today at ${next.time}` : next.offset === 1 ? `tomorrow at ${next.time}` : `${capitalize(next.weekday)} at ${next.time}`;
}

function capitalize(day: Weekday): string {
  return ({ mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' } as const)[day];
}
