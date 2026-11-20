import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
import { e164 } from './common.js';

/*
 * Phone numbers someone will be put through to or refused from (QA-106, ADR 0044). The
 * portal and the API judge an entry with the same function, so a row the form accepts is
 * a row the request accepts.
 *
 * The country code must be typed. `4165550101` read with an implied `+` is Switzerland
 * (+41) and `5145550123` is Peru (+51); there is no default region here, so a number
 * without `+` or `00` is refused, never guessed.
 *
 * Two rules, because only one of the lists is dialled:
 *   hand-off targets  `dialableE164`: a real number (`max` metadata — `min` checks length
 *                     only and calls `+5145550123` a valid Peruvian number)
 *   blocked callers   `blockedCaller`: `+` and up to 15 digits. The list is compared with
 *                     the caller ID the carrier sent and never dialled, and a spoofed or
 *                     odd caller ID is the one a customer most wants to block
 */

/** Spaces, dots, hyphens and brackets are formatting; anything else makes the entry unreadable. */
const TYPED_NUMBER = /^(?:\+|00)[\d\s().-]+$/;

/** A typed entry with its country code → `+<digits>`, formatting and a `00` prefix removed; null without one. */
function typedInternational(input: string): string | null {
  const trimmed = input.trim();
  if (!TYPED_NUMBER.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  return `+${trimmed.startsWith('00') ? digits.slice(2) : digits}`;
}

/**
 * A number as typed ("+1 (416) 555-0101", "0044 20 7183 8750") → E.164 (`+14165550101`),
 * or null when it does not start with its country code or is not a real number.
 */
export function toDialableE164(input: string): string | null {
  const international = typedInternational(input);
  if (!international) return null;
  const parsed = parsePhoneNumberFromString(international);
  return parsed?.isValid() ? parsed.number : null;
}

/** Line types a local number can have. Toll-free, premium and the rest are not area codes. */
const LOCAL_LINE_TYPES = new Set(['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE']);

/**
 * The country a North American area code is assigned to (`416` → `CA`, `212` → `US`,
 * `787` → `PR`), or null when no local numbers exist under it (`999`, `555`, toll-free
 * `800`). Read from the same metadata as `toDialableE164`, so it follows new codes with
 * the library and there is no list of ours to keep.
 */
export function areaCodeCountry(code: string): string | null {
  if (!/^[2-9]\d{2}$/.test(code)) return null;
  const parsed = parsePhoneNumberFromString(`+1${code}5550100`);
  if (!parsed?.isValid() || !parsed.country) return null;
  const type = parsed.getType();
  return type && LOCAL_LINE_TYPES.has(type) ? parsed.country : null;
}

/** Already canonical E.164 and a real number: what a request may store. `+4402071838750` is not canonical (the trunk 0). */
export function isDialableE164(value: string): boolean {
  return toDialableE164(value) === value;
}

/** `e164`'s shape (and its OpenAPI pattern), then a real number in canonical form. */
export const dialableE164 = e164.refine(
  isDialableE164,
  'Not a phone number in international format, e.g. +14165550101',
);

/**
 * A caller ID the way the §13.9 inbound check compares it with the block list: digits
 * and one leading `+` (added when the carrier sent none). `''` when there are no digits.
 */
export function normaliseCallerId(value: string): string {
  const digits = value.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : `+${digits}`;
}

/** `+` and 1–15 digits (E.164's ceiling): any caller ID in international format. */
const BLOCKED_CALLER = /^\+\d{1,15}$/;

/** A block-list entry as typed → `+<digits>`, or null when it does not start with `+` / `00` or is not digits. */
export function toBlockedCaller(input: string): string | null {
  const international = typedInternational(input);
  return international && BLOCKED_CALLER.test(international) ? international : null;
}

/** What Recent callers' "Block" saves for the caller ID the carrier sent; null when there is nothing to block. */
export function blockedCallerFromCallerId(callerId: string): string | null {
  const normalised = normaliseCallerId(callerId);
  return BLOCKED_CALLER.test(normalised) ? normalised : null;
}

export const blockedCaller = z
  .string()
  .regex(BLOCKED_CALLER, 'Not a phone number in international format, e.g. +14165550101');

/**
 * The number a saved entry was probably meant to be, when it is not a real number but its
 * digits read as a national number of `country` are: `+4165550101` with CA → `+14165550101`.
 * That is the shape the portal wrote before QA-106 (a `+` put in front of what was typed).
 * Null for a real number, for one with no such reading, or without a country. A guess for
 * the customer to accept, never applied by itself.
 */
export function nationalReading(stored: string, country: string | null | undefined): string | null {
  if (!country || !/^\+\d+$/.test(stored)) return null;
  if (parsePhoneNumberFromString(stored)?.isValid()) return null;
  const parsed = parsePhoneNumberFromString(stored.slice(1), country.toUpperCase() as CountryCode);
  return parsed?.isValid() ? parsed.number : null;
}
