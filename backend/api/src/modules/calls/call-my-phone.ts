import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * D17 "Call my phone" (W5, spec p. 24): which phone the agent may ring. The button is for
 * the customer to hear their agent on their own phone, not an outbound dialler (that is
 * D18, behind its compliance gates), so the destination is held to a narrow shape:
 *
 *   - a real number for its country (`libphonenumber-js/max`, the same metadata the
 *     captured-phone check uses);
 *   - in a country the call may go to — the number's own, or the workspace's;
 *   - not a premium-rate, shared-cost or other number someone else is paid to receive.
 *
 * Which of *our* numbers it may not be is the service's question (it needs the database).
 */
export type DestinationVerdict =
  | { ok: true; e164: string; country: string }
  | { ok: false; reason: 'invalid' | 'country' | 'type' };

/** Number types a test call never rings: someone else is paid for the minutes, or nobody answers. */
const REFUSED_TYPES = new Set(['PREMIUM_RATE', 'SHARED_COST', 'UAN', 'PAGER', 'VOICEMAIL']);

export function checkTestDestination(to: string, allowedCountries: readonly string[]): DestinationVerdict {
  const parsed = parsePhoneNumberFromString(to);
  if (!parsed || !parsed.isValid() || !parsed.country) return { ok: false, reason: 'invalid' };
  if (!allowedCountries.includes(parsed.country)) return { ok: false, reason: 'country' };
  const type = parsed.getType();
  if (type && REFUSED_TYPES.has(type)) return { ok: false, reason: 'type' };
  return { ok: true, e164: parsed.number, country: parsed.country };
}
