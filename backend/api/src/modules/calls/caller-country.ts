import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * The ISO 3166-1 alpha-2 country of a caller's number, for the §13.9 allowed-countries
 * check (ADR 0035). Read from the number alone — never from a caller-supplied country
 * field — and only from a number that carries its own country code: Retell sends
 * `from_number` in E.164, and a national number has nothing to say which country it is
 * from, so it is not guessed. Null for anything else: withheld (`anonymous`, the
 * carriers' `+266696687` placeholder), malformed, or a number libphonenumber does not
 * know a country for. The decision treats null as "not allowed" while a restriction is
 * set, and the blocklist keeps its own, looser normalisation.
 */
export function callerCountry(from: string | null | undefined): string | null {
  if (!from) return null;
  const text = from.trim();
  if (!text.startsWith('+')) return null;
  const parsed = parsePhoneNumberFromString(text);
  if (!parsed || !parsed.isValid() || !parsed.country) return null;
  return parsed.country;
}
