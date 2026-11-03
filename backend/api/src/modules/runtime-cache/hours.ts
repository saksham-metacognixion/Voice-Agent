import { type BusinessHours, type Weekday, businessHours, isOpen, nextOpeningAt } from '@portal/schemas';

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

/** `tenants.business_hours_json` / `phone_numbers.hours_override_json` as a schedule; unreadable = none. */
export function parseBusinessHours(value: unknown): BusinessHours | null {
  if (!value) return null;
  const parsed = businessHours.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface BusinessVariables extends Record<string, string> {
  business_open: 'true' | 'false';
  /** Short English phrase ("tomorrow at 09:00"), or '' while open or when the schedule never opens. */
  next_open_time: string;
  /** HH:MM in the business's zone, or the instant in ISO when the zone cannot be read. */
  current_time: string;
}

/**
 * §9.7 `{{business_open}}`, `{{next_open_time}}` and `{{current_time}}` for one call, from
 * the *workspace's* hours and timezone at the moment the call starts (ADR 0035, audit
 * §6.1 #5). One function for the inbound webhook, the W5 browser test, "Call my phone"
 * and the website widget, so the agent is told the same thing on every channel. No hours
 * set = open, the same reading the §13.9 answering check gives (`no_schedule`); a zone
 * Intl cannot read = open too, never a hard-coded value and never the server's clock.
 */
export function businessVariables(hours: BusinessHours | null | undefined, at: Date, timeZone: string): BusinessVariables {
  const verdict = isOpen(hours, at, timeZone);
  return {
    business_open: verdict.open ? 'true' : 'false',
    next_open_time: verdict.open ? '' : (nextOpening(hours, at, timeZone) ?? ''),
    current_time: verdict.clock?.time ?? at.toISOString(),
  };
}
