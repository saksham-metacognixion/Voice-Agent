import { isSupportedCountry, type CountryCode } from 'libphonenumber-js/max';

/**
 * The countries a caller's phone number is expected from: the workspace's own country,
 * then the region of each of the agent's locales (`en-IN` → India). What `captured_checks`
 * validates a captured number in. Deliberately not handed to the voice agent as a digit
 * count: it cannot count spoken digits (see `FIXED_PLATFORM_GUARDRAILS`).
 */
export function phoneRegions(country: string | null | undefined, locales: readonly (string | null | undefined)[] = []): CountryCode[] {
  const out = new Set<CountryCode>();
  for (const candidate of [country, ...locales.map((l) => (l ? localeRegion(l) : null))]) {
    const code = candidate?.trim().toUpperCase();
    if (code && isSupportedCountry(code)) out.add(code);
  }
  return [...out];
}

/** `en-IN` → `IN`; a locale without a region adds nothing. */
export function localeRegion(locale: string): string | null {
  const m = /^[a-z]{2,3}[-_]([a-z]{2})$/i.exec(locale.trim());
  return m ? m[1]!.toUpperCase() : null;
}
