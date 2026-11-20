import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { REFUSED_TYPES } from '../calls/call-my-phone';

export type OutboundDestination = { ok: true; e164: string; country: string } | { ok: false };

/**
 * The number a callback would ring: the other party of a D2 call, as the platform recorded
 * it. A withheld caller (`anonymous`, empty), a number that is not real for its country, or
 * one somebody else is paid to receive (premium-rate and the like, the same list "Call my
 * phone" refuses) is not dialled.
 */
export function readDestination(raw: string | null | undefined): OutboundDestination {
  const text = raw?.trim();
  if (!text || !text.startsWith('+')) return { ok: false };
  const parsed = parsePhoneNumberFromString(text);
  if (!parsed || !parsed.isValid() || !parsed.country) return { ok: false };
  const type = parsed.getType();
  if (type && REFUSED_TYPES.has(type)) return { ok: false };
  return { ok: true, e164: parsed.number, country: parsed.country };
}

export { maskNumber } from '../../common/mask';
