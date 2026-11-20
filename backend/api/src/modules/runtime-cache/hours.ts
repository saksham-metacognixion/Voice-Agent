import { type BusinessHours, type Weekday, businessHours, isOpen, localClock, nextOpeningAt } from '@portal/schemas';

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
  /** The business's wall clock with its day and date, "Wednesday 16 September 2026, 10:00". */
  current_time: string;
}

/**
 * §9.7 `{{business_open}}`, `{{next_open_time}}` and `{{current_time}}` for one call, from
 * the *workspace's* hours and timezone at the moment the call starts (ADR 0035, audit
 * §6.1 #5). One function for the inbound webhook, the W5 browser test, "Call my phone"
 * and the website widget, so the agent is told the same thing on every channel. No hours
 * set = open, the same reading the §13.9 answering check gives (`no_schedule`); a zone
 * Intl cannot read = open too, never a hard-coded value and never the server's clock.
 *
 * `current_time` carries the day and the date, not only HH:MM (ADR 0038): an agent asked
 * "are you open Saturday?" or told "tomorrow at 09:00" cannot place either without
 * knowing what today is. It is the hours' own zone when they name one, else the
 * workspace's, and UTC — said so — only for a zone Intl cannot read.
 */
export function businessVariables(hours: BusinessHours | null | undefined, at: Date, timeZone: string): BusinessVariables {
  const verdict = isOpen(hours, at, timeZone);
  return {
    business_open: verdict.open ? 'true' : 'false',
    next_open_time: verdict.open ? '' : (nextOpening(hours, at, timeZone) ?? ''),
    current_time: spokenClock(at, hours?.timezone ?? timeZone),
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Wednesday 16 September 2026, 10:00" in `timeZone`; the same in UTC, marked, when the zone is unreadable. */
export function spokenClock(at: Date, timeZone: string): string {
  const local = localClock(at, timeZone);
  const clock = local ?? localClock(at, 'UTC');
  if (!clock) return at.toISOString();
  const [year, month, day] = clock.date.split('-').map(Number) as [number, number, number];
  return `${capitalize(clock.weekday)} ${day} ${MONTHS[month - 1]} ${year}, ${clock.time}${local ? '' : ' UTC'}`;
}

/** What the call is about, beside the hours: who answers, for whom, in what language, and who is calling. */
export interface CallFacts {
  /** `tenants.name`. */
  businessName: string;
  /** The name the agent introduces itself by — `spokenAgentName()`. */
  agentName: string;
  /** The other party's number: the caller inbound, the person rung on an outbound or "Call my phone" call. Null on the web. */
  callerNumber: string | null;
  /** The agent's main language, our locale id (`ar-AE`, not the platform's `ar-SA`). */
  primaryLanguage: string;
  /** The workspace's hours (`tenants.business_hours_json`), not a number's answering schedule. */
  businessHours: BusinessHours | null | undefined;
  /** `tenants.timezone`. */
  timeZone: string;
}

export interface CallVariables extends BusinessVariables {
  business_name: string;
  agent_name: string;
  /** E.164, or '' when there is none (a browser call, a withheld number). */
  caller_number: string;
  primary_language: string;
}

/**
 * Every §9.7 variable for one call (ADR 0038): `{{business_name}}`, `{{agent_name}}`,
 * `{{caller_number}}`, `{{current_time}}`, `{{business_open}}`, `{{next_open_time}}`,
 * `{{primary_language}}`. The one builder for the inbound allow, the browser test, "Call my
 * phone", the website widget and the outbound callback, so an agent hears the same facts on
 * every channel. Pure and cheap: it runs on the §13.9 hot path. Every value is a string —
 * the platform leaves an unsupplied `{{variable}}` in the prompt as literal braces.
 */
export function callVariables(facts: CallFacts, at: Date): CallVariables {
  return {
    business_name: facts.businessName,
    agent_name: facts.agentName,
    caller_number: facts.callerNumber ?? '',
    primary_language: facts.primaryLanguage,
    ...businessVariables(facts.businessHours ?? null, at, facts.timeZone),
  };
}

/**
 * The name the agent introduces itself by: the brief's `agent_name` (W2, "Sophie") when it
 * has one, else the agent's own name in the portal. Read leniently from a stored
 * `brief_json` — the published version's on a live call, the tested version's on a test —
 * so the inbound path and the browser test cannot disagree about it.
 */
export function spokenAgentName(briefJson: unknown, fallback: string): string {
  const name = typeof briefJson === 'object' && briefJson !== null ? (briefJson as { agent_name?: unknown }).agent_name : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : fallback;
}
