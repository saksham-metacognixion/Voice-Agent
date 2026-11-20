import { type CountryCode, type PhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { asciiDigits } from './captured-phones';

/**
 * D17 "Call my phone" (W5, spec p. 24): which phone the agent may ring. The button is for
 * the customer to hear their agent on their own phone, not an outbound dialler (that is
 * D18, behind its compliance gates), so the destination is held to a narrow shape:
 *
 *   - a real number for its country (`libphonenumber-js/max`, the same metadata the
 *     captured-phone check uses), typed however the customer types it: Eastern Arabic
 *     digits, `00` for `+`, or a national number read in the allowed countries in turn
 *     (`0501234567` for a Saudi workspace) — the portal sends what was typed;
 *   - in a country the call may go to — the number's own, or the workspace's;
 *   - not a premium-rate, shared-cost or other number someone else is paid to receive.
 *
 * Which of *our* numbers it may not be is the service's question (it needs the database).
 */
export type DestinationVerdict =
  | { ok: true; e164: string; country: string }
  | { ok: false; reason: 'invalid' | 'country' | 'type' };

/** Number types a test call never rings: someone else is paid for the minutes, or nobody answers. */
export const REFUSED_TYPES: ReadonlySet<string> = new Set(['PREMIUM_RATE', 'SHARED_COST', 'UAN', 'PAGER', 'VOICEMAIL']);

export function checkTestDestination(to: string, allowedCountries: readonly string[]): DestinationVerdict {
  const parsed = parseTyped(to, allowedCountries);
  if (!parsed || !parsed.isValid() || !parsed.country) return { ok: false, reason: 'invalid' };
  if (!allowedCountries.includes(parsed.country)) return { ok: false, reason: 'country' };
  const type = parsed.getType();
  if (type && REFUSED_TYPES.has(type)) return { ok: false, reason: 'type' };
  return { ok: true, e164: parsed.number, country: parsed.country };
}

/** Bidi marks an RTL input or a paste can carry around the digits. */
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A number as typed, read in the allowed countries in turn (also the D18 do-not-call list's input). */
export function parseTyped(to: string, countries: readonly string[]): PhoneNumber | undefined {
  const text = asciiDigits(to).replace(BIDI_MARKS, '').trim().replace(/^00/, '+');
  if (text.startsWith('+')) return parsePhoneNumberFromString(text);
  const readings = countries.map((country) => parsePhoneNumberFromString(text, country as CountryCode));
  return readings.find((p) => p?.isValid()) ?? readings.find(Boolean);
}
